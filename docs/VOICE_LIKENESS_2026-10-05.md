# Voice likeness study (October 5–6, 2026)

Goal: make cloned Cyberpunk 2077 voices sound like the real characters. The study covered Pocket TTS (the CPU route) and OmniVoice (the GPU route). It measures where likeness is lost, which metric matches the user's ears, and which changes help.

## How it was measured

- **Panel:** 67 voices × 2 held-out game lines (134 lines). Every model speaks the original line's own text.
- **Inputs:** `E:\CyberpunkConvai-offload\work\likeness-phase1\out\evaluation-sets.json` indexes the panel, the multi-clip sets and the excluded clips.
- **Fences:** the evaluation lines and every reference clip are excluded from the real clips used for comparison. The new OmniVoice LoRA and Mimi decoder never trained on the evaluation lines. The older fine-tuned Pocket models did see most of them.
- **Perceptual likeness score (PLS)** in `scripts/pocket_training/likeness.py`, CLI `scripts/Evaluate-VoiceLikeness.py`. It averages three components:
  - the full-band MFCC Fréchet distance to the voice's own real clips (timbre and recording character);
  - the DTW mel-cepstral distance to the original recording of the same line (delivery, articulation and timbre);
  - the spectrum error above 8 kHz.

  Each component is mapped so stock Pocket = 60 and OmniVoice 32 steps = 90. The original game lines score about 104–106.
- **Validation:** calibrated only on those two points, PLS puts the fine-tuned Pocket students at 68–70. That matches the user's ears (OmniVoice ~90 > fine-tuned Pocket ~70 > stock Pocket ~60).
- **Rejected metrics:**
  - WavLM-base-plus-SV against one reference is saturated: all models score within about 0.03.
  - UTMOS and DNSMOS rate the real game lines lowest; they reward clean audiobook speech.
- **Guards:**
  - ECAPA (VoxCeleb) cosine to the voice's real-clip centroid (right person at all);
  - WER with Whisper small.en. Real lines score 6.0% because of names and processing.

## Findings

1. **Pocket's ceiling was its codec.** A Mimi round trip of real lines lost more than OmniVoice generating from scratch:

   | | Mimi round trip of real lines | OmniVoice generated |
   |---|---|---|
   | Spectrum error above 8 kHz | 6.9 dB | 3.7 dB |
   | Timbre distance | 913 | 947 |
   | ECAPA | 0.53 | 0.62 |

   No language-model recipe can recover that; see the decoder fine-tune in item 5.
2. **Fine-tuning helped Pocket's delivery, not its codec limits.** The student scores 69.5 PLS vs 60 for base, with ECAPA 0.43 vs 0.40.
   - The 24-layer teacher fine-tune is flat against its base.
   - No newer Pocket release exists (upstream HEAD is `41cbc84`).
   - english_2026-09_24l is no better than english_2026-04_24l.
3. **Multi-clip references were the largest cheap win.** Clips are whole, picked as the voice's most typical by ECAPA, with the evaluation lines excluded. 16 steps is primary (the user's default):

   | Model | Single | 10 s two-clip | 18 s three-clip |
   |---|---|---|---|
   | OmniVoice 16 steps | 86.5 / 0.62 / 5.1% | 97.4 / 0.65 / 5.0% | 99.5 / 0.68 / 4.9% |
   | OmniVoice 32 steps | 90.0 / 0.62 / 4.5% | 100.2 / 0.65 / 4.6% | 103.2 / 0.68 / 4.8% |
   | Pocket student 5,000 | 69.5 / 0.43 / 4.2% | 81.7 / 0.48 / 4.7% | 83.9 / 0.50 / 4.5% |

   (PLS / ECAPA / WER)

   - OmniVoice latency: per the latency agent, the 18 s reference adds 38–51% to first audio, while 10 s adds about 7%. Pocket only pays once, in prepare.
   - Proposed configs (none active):
     - `runtime/pocket-voices.multiref.json` and `runtime/local-voices.multiref.json` (18 s), audio in `runtime/voice-references/multiref-proposed/`;
     - `runtime/local-voices.multiref10.json` (10 s), audio in `runtime/voice-references/multiref10-proposed/`.
   - Per voice the result is hit or miss: delivery improved for 36 of 59 voices and worsened for 23.
     - Loudness-matched clip sets scored worse.
     - A dev-line automatic selector tied "most typical" (99.2 vs 99.5).
     - Manual picks (the picker app) are the remaining lever.
4. **OmniVoice LoRA: no gain.** It used the upstream recipe: rank 32, lr 1e-4, 3,000 steps on Kaggle 2×T4, policy `omnivoice_lora_game_v1`, launcher `scripts/OmniVoice-LoraKaggle.py`.
   - Single reference: flat (86–88 PLS at 16 steps; 89.6–90.3 at 32).
   - Multi-clip references: worse (94–96 at 16 steps vs 97–100 for base).
   - Likely cause: the recipe trains on same-utterance prompts, so long multi-clip prompts fall out of its training distribution.
   - ECAPA and WER are unchanged. Not recommended unless a cross-utterance, multi-clip prompt recipe is built.
5. **Mimi decoder fine-tune (Pocket): large texture gain at zero runtime cost.** Policy `mimi_decoder_gan_v1`, trainer `scripts/pocket_training/mimi_decoder.py`.
   - **What trains:** only the decoder side (quantizer projection, upsample, decoder transformer, SEANet decoder; 10.3 M parameters). The encoder, latent space and FlowLM are frozen.
   - **Recipe:** multi-scale mel loss to 12 kHz, a multi-scale STFT GAN and feature matching.
   - **Run:** 3 h on the local 4080, 15,474 updates.
   - **Held-out result:** log-mel error 1.40 → 0.84; error above 8 kHz 6.5 → 2.1 dB.
   - **Round trip of real lines:** high band 6.9 → 3.4 dB, timbre 913 → 535 (real clips 520), ECAPA 0.53 → 0.57.
   - **Pocket student 5,000 through the new decoder:** PLS 105 (single), 114 (10 s), 116 (18 s), with ECAPA 0.46 / 0.51 / 0.53 and WER 4.0% / 4.4% / 4.7%.
   - **Caveats:**
     - PLS now exceeds OmniVoice, but speaker identity (ECAPA) is still below OmniVoice's 0.62–0.68.
     - The decoder was trained adversarially on these 79 voices, so PLS may over-reward a game-like spectrum. Listen for metallic or buzzy highs.
   - **Weights:** `E:\CyberpunkConvai-offload\work\mimi-dec\local-A-final-ema-step15474.safetensors` (41 MB, decoder tensors only).
   - **Packaging:**

     ```
     python scripts/pocket_training/apply_decoder.py --export <Pocket export dir> \
         --decoder <decoder.safetensors> --out <new export dir>
     ```

     It replaces only the decoder-side `mimi.*` tensors and writes `decoder-receipt.json`.
   - **Candidate export:** `E:\CyberpunkConvai-offload\work\mimi-dec\exports\s5000-raw-decA`, i.e. student 5,000 raw plus the new decoder. It ran through the runtime streaming path on CPU at RTF 0.43 with 4 threads, the same cost as before.
   - **Kaggle attempts:** two runs (`Pocket-MimiDecoder.py`) died with no log or output. The launcher now publishes progress to a fresh bucket run path every 15 minutes. The successful run was local.

## Files

| What | Where |
|---|---|
| Listening page (standard columns plus every candidate, OmniVoice at 16 and 32 steps; PLS, guard and WER per column) | `E:\CyberpunkConvai-offload\work\likeness-phase1\page\index.html` |
| Summary table | `page\summary-table.md` |
| Scores | `out\perceptual.json`, `out\scores.json`, `out\wer.json`, `out\ref_analysis.json`, `out\selection_s16.json` |
| Ad-hoc experiment scripts (generation, scoring, multi-clip builders) | `E:\CyberpunkConvai-offload\work\likeness-phase1\exp-scripts\` |
| Reusable pieces | `scripts/pocket_training/likeness.py`, `scripts/Evaluate-VoiceLikeness.py`, `scripts/pocket_training/mimi_decoder.py`, `scripts/pocket_training/apply_decoder.py`, `scripts/Pocket-MimiDecoder.py`, `scripts/OmniVoice-LoraKaggle.py` |
