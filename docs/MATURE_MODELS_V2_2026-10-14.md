# Mature models, round 2 (2026-10-14)

Why: the user's verdict on `docs/MATURE_SAMPLES_2026-10-13.md` was "too tame, check online for better models or push them harder, and cut the model options to two, a lite and a good one, like normal mode". The prompt was pushed (see `docs/LOCAL_AI.md`, "Pushed harder"); this note is the model side. Nothing here was downloaded or run: the files are listed from Hugging Face pages and the API only, and the picks are unconfirmed until the eval below has run on them.

## What the community data says

- UGI Leaderboard (snapshot to about September 2026, the CSV on the Space `DontPlanToEnd/UGI-Leaderboard`): the willingness column (W/10) and the NSFW score move differently. Removing refusals lifts W/10 a lot and the NSFW score hardly at all. Stock Gemma-4-E4B: W/10 2.2, NSFW 4.3. Its heretic and "ultra-uncensored" variants: W/10 9.2 to 10, NSFW 4.3 to 4.8. Qwen3.5-9B abliterated or heretic variants: NSFW 3.7 to 5.2. Dedicated NSFW or roleplay finetunes: 7 to 10. (The NSFW column's exact definition was not verified.)
- The HauhauCS models (the 2B, 4B and 9B of the first test) are not on UGI. Their own card says "No changes to datasets or capabilities" and names no erotic or roleplay training, so they remove refusals and add no skill. That matches "too tame": the first test set was the wrong kind of model, not only a prompt problem.
- Reddit could not be read, and web search returned only SEO pages, so there is no usable r/LocalLLaMA or r/SillyTavernAI evidence in this round. The 2026 community work is mostly 27 to 31B finetunes, which do not fit the game's graphics-memory budget.
- No small model was found that is both trained for explicit roleplay and verified as such. Both picks are the best reading of thin evidence. No generation was tested.

## Size classes (the same rule as normal mode)

Free graphics memory needed = file + headroom: lite file + 0.7 GB, good (standard) file + 1.2 GB (`docs/LOCAL_AI.md`, "Choosing the model"). Normal mode ships Qwen3.5-2B (1.28 GB) and Gemma 4 E4B (5.15 GB). No good 2B uncensored roleplay model was found, so the Mature lite is a 4B at Q4_K_M, about 2.7 GB (needs about 3.4 GB free); the good one stays at the E4B size (5.3 GB, needs about 6.5 GB free).

## Lite candidates (about 2.5 to 2.7 GB)

| Candidate | File | Size | Licence | Template | Why |
|---|---|---|---|---|---|
| **Nubinu/Qwen3.5-4B-MiniFantasy-GGUF (pick)** | `Q4_K_M/Qwen3.5-4B-MiniFantasy-Q4_K_M.gguf` | 2,708,796,576 B (2.71 GB) | Apache-2.0, not gated | Qwen3.5 (same path as the current pack, thinking off) | LoRA for multi-turn narrative roleplay on a heretic base. UGI (no-thinking row): NSFW 6.5 (stock Qwen3.5-4B 3.7, other 4B heretics 3.9 to 4.5), W/10 8.8, Writing 30. The best mix of willingness and coherence among Qwen3.5-4B models. Training data is not documented. |
| mradermacher/Qwen3-4B-Nymphaea-RP-i1-GGUF | `Qwen3-4B-Nymphaea-RP.i1-Q4_K_M.gguf` | 2.50 GB | Apache-2.0, not gated | ChatML | Qwen3-4B-Instruct-2507 abliterated, then DoRA-tuned on a roleplay mix; card says "quite uncensored". Not on UGI. Non-thinking base. Source `0xA50C1A1/Qwen3-4B-Nymphaea-RP`. |
| PantheonUnbound/Satyr-V0.1-4B | `Satyr-V0.1-4B-Q4_K_M.gguf` | 2.50 GB | Apache-2.0, not gated | Qwen3 | UGI NSFW 10.0, W/10 6.8, but Writing only 8.2 and NatInt 11: very willing, a weak writer. Thinking-only base (latency risk, breaks the thinking-off setup). Old (October 2025). |

Rejected: Qwen3.5-4B-NSFW-ARA-Heretic-Literotica (trained on erotic stories, not spoken dialogue; no licence stated), an anonymous Qwen3.5-text-9B-NSFW-RP (no licence, no card, 5.6 GB), Impish_LLAMA_4B (NVIDIA Open Model Licence), Gemmasutra-Mini-2B (old, low NatInt).

## Good candidates (4 to 5.5 GB)

| Candidate | File | Size | Licence | Template | Why |
|---|---|---|---|---|---|
| **Nubinu/Gemma4-E4B-MiniFantasy-V1-GGUF (pick)** | `Q4_K_M/Gemma4-E4B-MiniFantasy-V1-Q4_K_M.gguf` | 5,335,290,656 B (5.34 GB) | Apache-2.0, not gated | Gemma (same as the standard pack) | LoRA (rank 32, 1 epoch) on gemma-4-E4B-it-SOMPOA-heresy. Same architecture and speed class as the standard model (about 4B effective compute), so the fastest of the good candidates. Not on UGI; the 4B sibling above is the only hint (NSFW 6.5). Dataset and refusal behaviour undocumented. |
| mradermacher/Ministral-3-8B-Nymphaea-RP-i1-GGUF | `Ministral-3-8B-Nymphaea-RP.i1-Q4_K_M.gguf` | 5.20 GB (IQ4_XS 4.70) | Apache-2.0, not gated | Mistral V7-Tekken | Abliterated, then DoRA-tuned on the same roleplay mix; "quite uncensored". Dense 8B, so slower per token than E4B (estimate, not measured: about 1.8x). The fallback if the pick is still tame. |
| mradermacher/gemma4-e4b-mahou-nsfw-i1-GGUF | `gemma4-e4b-mahou-nsfw.i1-Q4_K_M.gguf` | 5.30 GB | tagged "gemma" (check) | Gemma | Despite the name: SFT on a SFW-only character dataset, then heretic. Refusals 99 to 3 of 100. Likely as tame as the heretic we already tried. |

Also seen: Luchador (bartowski/rpDungeon_Gemma-4-E4B-Luchador-GGUF, 5.41 GB, a general roleplay merge, no explicitness information, labelled "gemma"); ArliAI/Qwen3.5-9B-RpRMax-v1 (5.63 GB, roleplay-trained, uncensored status unknown, dense 9B, thinking-trained); ReadyArt Omega-Directive-M-8B (UGI NSFW 9.7, but the Mistral Research Licence and manually gated, so not redistributable). No useful small mixture-of-experts model exists in range (LFM2.5-8B-A1B scores very low on roleplay; Gemma-4-26B-A4B is 16 GB).

## Picks

- **Lite: `Nubinu/Qwen3.5-4B-MiniFantasy-GGUF`, `Q4_K_M/Qwen3.5-4B-MiniFantasy-Q4_K_M.gguf`**, 2,708,796,576 bytes, Apache-2.0, revision `84d82263ef444991519d30b63c2d73482659b23e`, SHA-256 `518915429d55e105cae2c44ae1138088ea0d5230cacff3bd5299ea13fd0397f3`.
- **Good: `Nubinu/Gemma4-E4B-MiniFantasy-V1-GGUF`, `Q4_K_M/Gemma4-E4B-MiniFantasy-V1-Q4_K_M.gguf`**, 5,335,290,656 bytes, Apache-2.0, revision `0affbba89d649061eea151c3266a026d23961f27`, SHA-256 `e67009205385bd00852f4aa722cf4c49dcf6892cd34c29c265c36a3014906cc2`.

Both are pinned in `packaging/release.config.json` (`maturePack.tiers`). Both families already work in the bridge (Qwen3.5 and Gemma 4 chat templates are embedded; the allowance table has a row for each; thinking is off for Qwen3.5 as for the current lite model). The Gemma 4 licence is Apache-2.0 on the base card; Google's separate prohibited-use link on it was not readable, so the pack's notice should keep the link, as the standard pack does.

If the eval shows either pick still tame, the next ones to try are Nymphaea-RP (Qwen3-4B, then Ministral-3-8B) in the same slots; swapping a model is one entry in the config and nothing else.

## Not verified

No generations were tested. Training data of MiniFantasy and Nymphaea is undocumented. OmniWriter returned HTTP 401. Download and like counts were read only as popularity signals. The licence of every finetune is bounded by its base model's.
