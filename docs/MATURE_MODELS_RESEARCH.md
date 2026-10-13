# Local models for the "Mature content" setting: research

Researched 2026-10-13. Desk research only: model cards, the Hugging Face listing API and the licence texts were read; **no model file was
downloaded and nothing was run**. Nothing below has been tested on this mod's prompts, so every behaviour claim is the uploader's or the
community's, not ours. See "What to verify before shipping".

## Summary

- **The premise about Gemma needs a correction.** Gemma 4 (released 2026-04-02) is plain Apache 2.0. The older "Gemma Terms of Use" and
  its Prohibited Use Policy applied to Gemma 1 to 3n. So the model we already ship (Gemma 4 E4B QAT q4_0, `google/...`, tagged
  `apache-2.0`) is not licence-blocked from adult fiction. It does refuse in practice: the Heretic project measured 99 of 100 refusals
  on its own test set for the stock Gemma 4 E4B (97 of 100 for stock Qwen3.5-2B).
- **Qwen3.5 (Apache 2.0, no use policy) is the cleanest base.** Mistral Nemo 12B (Apache 2.0) is the cleanest for roleplay-tuned
  12B models, but most Nemo fine-tunes carry no licence text at all.
- **Drop-in swaps exist for both tiers**: same architecture and size as what ships, so the measured speed and VRAM figures in
  `docs/LOCAL_MODEL_CHOICE.md` carry over.
- **An abliterated model has no limits of its own.** The hard limits (minors, non-consent) can then only come from the prompt and from a
  check on the output. Plan for that in the Mature setting; do not rely on the model.
- Evidence that any small model "stays in character" is thin. What exists is download counts, likes and uploader claims. The one
  roleplay-tuned family with a real reputation is the Nemo 12B group (Mag-Mell, Rocinante), which does not fit the standard tier.

## How optional models work today (what a proposal has to fit)

- `packaging/release.config.json`, block `localAi`: one pinned `server` (llama.cpp b11560 Vulkan, MIT), one `embed` model, and `tiers.standard` /
  `tiers.lite`, each with `repository`, `revision`, `file`, `size`, `sha256`, `local`, `license`.
- `packaging/build-release.mjs --packages localai-standard|localai-lite` downloads the unmodified upstream file from its pinned Hugging Face
  URL in CI, checks the SHA-256, and re-hosts it in a GitHub release zip (asset limit 1.95 GB; larger files split into 1 GB parts joined on
  first start by `app/launcher/assemble-parts.mjs`). The pack unpacks to `app/local-ai/` with a manifest fragment (`manifest.standard.json`,
  `manifest.lite.json`), licence texts and `THIRD-PARTY-NOTICES.txt`. `bridge/local-ai-pack.mjs` only stats files.
- Because we **re-host**, the licence must allow redistribution. Apache 2.0 does (keep the licence text, note the modification).
  A model with no licence text can only be offered by sending the player to the original host.
- Tier choice is by free VRAM: standard needs its file size plus 1,200 MiB, lite its file size plus 700 MiB (`bridge/local-llm-server.mjs`).
  The measured standard cost (3.1 GB loaded from a 5.15 GB file) is because the Gemma "per-layer embeddings" stay in system memory.

A Mature variant fits as one more tier entry per tier (for example `tiers.standardMature`, `tiers.liteMature`), a manifest fragment that
names it, and a pack target (`localai-standard-mature`). The bridge picks the variant from the Mature setting. The server and the embedder
are shared. A player who wants both the normal and the Mature model downloads both, so the drop-in sizes below matter. Cheaper option for
lite: ship only the abliterated model (1.2 GB, no extra download) and let the prompt decide.

## Licence findings (read from the sources)

| Base | Licence | Use policy | Verdict for adult fiction |
|---|---|---|---|
| Qwen3.5 (2B, 4B, 9B) | Apache-2.0 (card tag on every repo checked) | None found | Allowed; redistribution allowed |
| Gemma 4 (E2B, E4B, 12B) | Apache-2.0. The "Gemma 4 license" page is the plain Apache text | The old Prohibited Use Policy page still exists (see below) | Allowed on my reading; small residual doubt |
| Mistral Nemo 12B | Apache-2.0 (card). Card: the model "does not have any moderation mechanisms" | None | Allowed |
| Ministral 3 (3B, 8B, 14B), Mistral Small 3.x | Apache-2.0 (card tags) | None found | Allowed |
| Qwen3-14B (under Hermes 4) | Apache-2.0 | None | Allowed |
| Llama 3.x | Llama community licence plus Acceptable Use Policy | See quote | Unclear; excluded |
| Gemma 1 to 3n | Gemma Terms of Use plus Prohibited Use Policy | See quote | Forbidden; excluded |

**Gemma Prohibited Use Policy** (ai.google.dev/gemma/prohibited_use_policy, "Last modified: February 21, 2024"), applies to "Gemma or
Model Derivatives". It forbids: "Generate sexually explicit content, including content created for the purposes of pornography or sexual
gratification", with the note "this does not include content created for scientific, educational, documentary, or artistic purposes", and
"Promoting or generating content related to child sexual abuse or exploitation". This is why Gemma 1 to 3n (and every repo that still carries the
`gemma` licence tag, such as the HauhauCS and rpDungeon Gemma 4 uploads) cannot be used for sexual content. For Gemma 4, the Google licence page is plain
Apache 2.0, and the Gemma 4 model card links no use policy. My reading is that the policy no longer binds Gemma 4. It is not legal
advice, the policy page has not been withdrawn, and a player-facing "Mature" feature on a Google base carries a little more doubt than the same on Qwen.
If that doubt matters, use the Qwen3.5 models and skip Gemma.

**Llama Acceptable Use Policy** (Llama 3.1 `USE_POLICY.md`): "Sexual solicitation"; "Human trafficking, exploitation, and sexual
violence"; "The illegal distribution of information or materials to minors, including obscene materials, or failure to employ legally
required age-gating in connection with such information or materials"; "Exploitation or harm to children, including the solicitation,
creation, acquisition, or dissemination of child exploitative content". Consensual adult fiction is not named, but "sexual solicitation" and the age-gating
clause make a sexual-content feature a grey area, and the licence also makes redistributors keep the Llama name and agreement. Excluded
(this removes Stheno, Lunaris and similar Llama 3 roleplay models).

Fine-tune licence tags are the uploader's and are sometimes wrong in both directions. For each pick below, the base is Apache 2.0 and the repo is tagged
`apache-2.0`, except Mag-Mell (no licence text anywhere).

## Shortlist

All speeds are measured on this project's RTX 4080 Laptop for the base model (`docs/LOCAL_MODEL_CHOICE.md`: Qwen3.5-2B 143 tokens/s,
Qwen3.5-4B 85, Gemma 4 E4B 79; warm first token 0.10 to 0.17 s) unless marked "estimate". Estimates scale by weight bytes, so a swap of the
same size and architecture should land within a few percent. All files are GGUF (safetensors source, no pickle or `.bin`). Exact file names
should be confirmed on each repo's Files tab and pinned by revision plus SHA-256 at packaging time, as the existing `localAi` block does.

### 1. Gemma 4 E4B "ultra uncensored" Heretic (standard)

- Repo and file: `llmfan46/gemma-4-E4B-it-ultra-uncensored-heretic-GGUF`, the `Q4_K_M` file, **5.34 GB** (Q5_K_M 5.76 GB, Q8_0 8.03 GB).
- Base and licence: `google/gemma-4-E4B-it`, Apache-2.0 (repo tag and Google's licence page).
- Behaviour: Heretic v1.2.0, "Arbitrary-Rank Ablation". Card: refusals 99/100 for the original, **3/100** for this one; KL divergence from
  the original **0.0076** (small, measured); MMLU 69.46 to 68.60, PIQA 86.02 to 85.85. 70,020 downloads last month, 230 likes.
- Why: it is the model we already measured as the best of four for grounding (4.56 of 5, fewest invented facts), with the same architecture,
  so about 3.1 GB VRAM, 0.53 s warm reply, 79 tokens/s and the same tag discipline should carry over. The small KL means the character
  grounding we measured should survive. Same download size as today's standard pack (5.34 vs 5.15 GB).
- Risks: Q4_K_M is not the QAT-trained q4_0 we ship, so expect a small quality drop. Uploader llmfan46 is an individual (70+ free models, says
  free storage is full and uploads depend on donations), so pin the revision and hash and mirror it ourselves. No roleplay tuning: it removes refusals,
  it does not teach roleplay. Remaining disclaimers possible. Gemma doubt above.
- Alternative of the same size: `huihui-ai/Huihui-gemma-4-E4B-it-qat-q4_0-unquantized-abliterated-GGUF` (Q4_0 5.3 GB, Apache-2.0, 13,691
  downloads). Abliterated from the QAT weights, so a q4_0 file matches our current quantisation. huihui-ai is a long-standing abliteration uploader. The card
  gives no refusal numbers and calls the method "a crude, proof-of-concept implementation".

### 2. Qwen3.5-4B "Uncensored HauhauCS Aggressive" (standard, smaller download)

- Repo and file: `HauhauCS/Qwen3.5-4B-Uncensored-HauhauCS-Aggressive`, `...-Q4_K_M.gguf`, **2.6 GB** (card; 2.71 GB in the file panel).
- Base and licence: `Qwen/Qwen3.5-4B`, Apache-2.0 (repo tag).
- Behaviour: card claims 0/465 refusals and "zero capability loss", method not described (unverified). 206,995 downloads, 622 likes.
  Card warns it "may occasionally append a short disclaimer".
- Why: half the download of Gemma (2.6 vs 5.3 GB), no use policy at all, about 3.05 GB VRAM and 85 tokens/s as measured for the base. Same
  overall score as Gemma in our test.
- Risks: in our own test the stock Qwen3.5-4B invented more and made up emotion tags (6 stray groups of 48 replies; the bridge cleans them).
  Refusal-free claim is self-reported. A single anonymous uploader, though the most downloaded in its class. Recent llama.cpp needed
  (we ship b11560, which is fine for the architecture we already run).
- Runner-up with measured numbers: `mradermacher/Qwen3.5-4B-heretic-i1-GGUF` (`i1-Q4_K_M` 2.7 GB, Apache-2.0, mradermacher is the most
  trusted quantiser; only 1,469 downloads last month and the card gives no refusal rate).

### 3. Qwen3.5-2B "Uncensored HauhauCS Aggressive" (lite)

- Repo and file: `HauhauCS/Qwen3.5-2B-Uncensored-HauhauCS-Aggressive`, `Qwen3.5-2B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf`, **1.2 GB** (1.27 GB in the file
  panel; ours is 1.28 GB).
- Base and licence: `Qwen/Qwen3.5-2B`, Apache-2.0 (repo tag).
- Behaviour: 0/465 refusals claimed, unverified. 52,897 downloads, 161 likes, the most downloaded uncensored 2B by a wide margin.
- Why: identical size and architecture to the shipped lite model, so about 1.4 to 1.5 GB VRAM and 143 tokens/s should carry over. It fits the
  under-2 GB lite tier with room to spare.
- Risks: a 2B model is plain at roleplay and loses quest and memory facts (our own finding), and removing refusals does not fix that. Treat it as
  the floor for ordinary NPCs, as the lite tier is today.
- Alternatives: `mradermacher/Huihui-Qwen3.5-2B-abliterated-GGUF` (9,553 downloads, Apache-2.0, trusted quantiser, abliteration of huihui-ai);
  `mradermacher/Qwen3.5-2B-heretic-i1-GGUF` (Heretic, cards for the 2B quote refusals falling from 97/100 to 7/100).

### 4. Qwen3.5-9B "Uncensored HauhauCS Aggressive" (12 GB cards)

- Repo and file: `HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive`, `Q4_K_M`, **5.3 GB** (5.63 GB in the file panel; Q6_K 6.9 GB).
- Base and licence: `Qwen/Qwen3.5-9B`, Apache-2.0 (repo tag).
- Behaviour: 0/465 refusals claimed, unverified; 712,534 downloads, 2,265 likes, the most liked model in the Qwen3.5-9B listing.
- Why: the best-supported mid-size option. Hybrid attention keeps the cache small like the 2B and 4B, so VRAM should be about 6 to 6.5 GB
  with 8k to 16k context (estimate). Speed about 40 tokens/s (estimate from weight bytes; 4B measured 85).
- Risks: it does not fit beside OmniVoice and a high-settings game on a 12 GB card; it suits Pocket voice (CPU) with lower settings, or
  16 GB cards. Self-reported refusal and quality claims. Thinking mode must stay off for latency.
- Safer-sounding alternative: `DavidAU/Qwen3.5-9B-The-Defiant-Fable-Uncensored-Heretic-...-GGUF` has 2,024,381 downloads, but it is a heavily
  customised multi-feature repo (imatrix "NEO MAX", MTP); not recommended for a pinned, reproducible pack.

### 5. Mistral Nemo 12B roleplay fine-tune: MN-12B-Mag-Mell-R1 (16 GB+ cards, the roleplay pick)

- Repo and file: `bartowski/MN-12B-Mag-Mell-R1-GGUF` or the author's `inflatebot/MN-12B-Mag-Mell-R1-GGUF`, `Q4_K_M`. Q4_K_M of a Nemo 12B is
  about **7.0 GB** (a published Nemo 12B Q4_K_M is 6.96 GB); I did not read the exact figure from this repo.
- Base and licence: a DARE-TIES merge on `Mistral-Nemo-Base-2407-chatml` (Apache-2.0) of Bophades, Wissenschaft, Chronos Gold, Sunrose,
  Gutenberg v4 and Magnum v2.5 KTO. **The card states no licence**, and several ingredients are themselves fine-tunes with their own tags.
- Behaviour: author: "Intended to be a general purpose 'Best of Nemo' model for any fictional, creative use case", strong worldbuilding,
  minimal slop. ChatML, temperature 1.25 with MinP 0.2 recommended, "stable up to about 10K context". The most downloaded MN-12B roleplay
  model in the listing (about 24,500 plus 4,800 downloads for the two quantisers last month). Merged from models trained on character-chat data, so this
  is where the "stays in character" reputation lives.
- Risks: no licence text, so we should not re-host it; the player's machine would download it from Hugging Face (needs a consent step and
  a pinned hash). Temperature 1.25 is hot for a structured action-tag format, so use lower temperature and test. 128k-capable base but tested
  to about 10K. About 8.5 to 9 GB VRAM with context (estimate: 7 GB weights plus about 1.3 GB cache at 8k), so a 16 GB card with Pocket voice,
  not a 12 GB card. About 30 tokens/s (estimate).
- Same-base alternatives: `TheDrummer/Rocinante-X-12B-v1-GGUF` (24,897 downloads, no licence tag), `mradermacher/MN-Violet-Lotus-12B-GGUF`
  (cc-by-4.0, merge). `BeaverAI`/TheDrummer Cydonia and Magidonia 24B (about 14.3 GB at Q4_K_M, no licence stated) suit 24 GB cards only.

### 6. Hermes 4 14B and Gemma 4 12B Heretic (16 GB+ cards, structured output)

- `NousResearch/Hermes-4-14B` through `bartowski/NousResearch_Hermes-4-14B-GGUF`, `Q4_K_M` **9.00 GB** (IQ4_XS 8.11 GB). Base Qwen3-14B,
  Apache-2.0 on the original card (the bartowski repo states none). Card: "extreme improvements on steerability, especially on reduced
  refusal rates", "broadly neutral alignment", trained "to produce valid JSON for given schemas and to repair malformed objects", tool calls
  in `<tool_call>` tags, optional `<think>` reasoning (leave off; the card recommends temperature 0.6, top_p 0.95, top_k 20). 68,709
  downloads. This is the best-documented structured-output model here, and it is not abliterated: its low refusal rate is trained in and
  we do not know how it treats explicit sexual content. About 10.5 GB VRAM and about 25 tokens/s (estimates). Too heavy for most players.
- `llmfan46/gemma-4-12B-it-uncensored-heretic-GGUF`, `Q4_K_M` **8.54 GB**, Apache-2.0, dense 12B with a 256K window. Refusals 6/100 but KL
  0.1203 (much higher than the E4B's 0.0076, so more drift from the original). 6,020 downloads. Same Gemma doubt.

## Excluded

- Anything under Gemma 1 to 3n terms (HauhauCS and rpDungeon Gemma 4 repos tagged `gemma`, `mahou-nsfw`, Luchador): tagged with the old licence or a
  mixed chain; the Gemma 4 ones are probably Apache in truth but the tag is a risk we do not need.
- Llama 3.x roleplay models (Stheno, Lunaris and others): AUP grey area and naming conditions, above.
- Erotica-tuned small models with no licence tag (`gemma-4-E4B-it-erotica`, `Qwen3.5-text-9B-NSFW-RP`, `Qwen3.5-4B-NSFW-ARA-Heretic-Literotica`): no
  redistribution rights, tuned toward a single kind of text, and untested for action tags.
- `cc-by-nc` models (Lyra, Estrella; Moranyunchen's Qwen3.5-4B uncensored): non-commercial.
- Anything not a plain GGUF.

## Recommendation, one per tier

| Tier | Pick | Size | Why |
|---|---|---|---|
| **Lite (under 2 GB)** | `HauhauCS/Qwen3.5-2B-Uncensored-HauhauCS-Aggressive`, Q4_K_M | 1.2 GB | Same size and architecture as today's lite, Apache base with no use policy, by far the most downloaded |
| **Standard (3 to 5 GB VRAM)** | `llmfan46/gemma-4-E4B-it-ultra-uncensored-heretic-GGUF`, Q4_K_M | 5.34 GB | The base we measured best, refusals 99 to 3 of 100 with KL 0.0076; same VRAM and speed. Take `HauhauCS/Qwen3.5-4B-...` (2.6 GB) instead if download size or the Gemma doubt matters more |
| **Large (12 GB and up)** | `HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive`, Q4_K_M | 5.3 GB | Apache, huge uptake, about 6 GB VRAM; for the roleplay-flavoured 16 GB+ player, Mag-Mell R1 (link to the original host, no re-hosting) |

## What to verify before shipping

1. **Refusal test on our prompts.** Run the Mature prompt with each candidate against a fixed set (profanity, violence, drugs, consensual
   sex, plus the hard limits). The refusal numbers above come from uploaders' own sets (Heretic's 100 prompts; HauhauCS's 465 undescribed ones).
2. **Hard limits.** An abliterated model will not enforce "no minors, no non-consent". The Mature prompt must say it and a cheap output check must
   catch it. This is the largest risk in the whole feature.
3. **Action tags and latency.** `scripts/Eval-MistralPrompt.mjs --actions --local <port>` (the doc notes the local model is not yet measured on it).
   Re-measure first token, tokens/s and VRAM on the 4080 for each swap, with the stage clock.
4. **Hashes and mirrors.** Pin revision and SHA-256 for every file; mirror it ourselves, because several uploaders are individuals and repos
   can be deleted or replaced.
5. **Gemma 4 wording.** If anyone wants certainty, ask Google to confirm that the Prohibited Use Policy does not apply to the Apache-licensed Gemma 4;
   otherwise ship Qwen.
6. **Quality of the 2B and 4B in roleplay.** Our earlier finding stands: small models are weak at holding facts. Mature mode on them gives
   frank text, not better characters.

## Sources

Hugging Face model cards and the listing API (`huggingface.co/api/models?search=...&filter=gguf&sort=downloads`, read 2026-10-13): llmfan46,
HauhauCS, huihui-ai, mradermacher, bartowski, inflatebot, TheDrummer, NousResearch, mistralai/Mistral-Nemo-Instruct-2407, google/gemma-4-E4B-it.
Licences: `ai.google.dev/gemma/docs/gemma_4_license`, `ai.google.dev/gemma/prohibited_use_policy`, Meta
`llama-models/models/llama3_1/USE_POLICY.md`. Project figures: `docs/LOCAL_AI.md`, `docs/LOCAL_MODEL_CHOICE.md`, `packaging/release.config.json`.
