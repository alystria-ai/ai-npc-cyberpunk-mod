# Character voice preparation

## Current shared Pocket training — October 4

The accepted six-layer Pocket student remains the development runtime model.
The user selected standard **A** after the all-Tier1 A/B/C listening comparison.
An expanded shared teacher is running privately on Kaggle; its successor student
has not started yet. Neither training completion nor a production replacement is
claimed from the provider's RUNNING status. Kaggle currently exposes no readable
step/loss log for this run, so remaining time cannot be inferred reliably.

The frozen corpus contains **8,140 training clips across 79 voice identities**,
plus 75 development, 87 conditional-development, 94 regression and 76 final-test
clips, with 24 original character references. Expanded collection prioritizes
thin character coverage and preserves exact game speaker/scene attribution.
Audio/transcript bank mismatches were corrected using actual STT and alignment
receipts; codec admission, recording aliases and split fences are frozen with
the corpus. Final-test audio is excluded from checkpoint selection. Conditional
development and seen-scene coverage stay explicitly labeled rather than being
presented as fully independent evaluation.

The teacher continues the selected A EMA initializer with a fresh optimizer,
learning rate 1e-5, 1,000-update warm-up, EMA 0.999 and global batch 64 on two
T4 GPUs using FP16. It allows up to 20,000 additional updates. Plateau stopping
requires at least 8,000 updates, 50 corpus passes and eight post-baseline speech
evaluations, then five non-improving evaluations. The best eligible checkpoint
and a full resumable checkpoint are retained; the final update is not assumed
to be the best model. Provider session boundaries require coherent continuation,
and a separate quota reserve is kept for distillation and verification.

After the actual teacher is selected, the student uses the accepted student
initializer and the new frozen teacher, not a separate character-specific model.
Its planned recipe has learning rate 5e-5, 250-update warm-up, EMA 0.999, global
batch 64, up to 12,000 updates and patient speech evaluation. The minimum gate
requires 4,000 updates, 50 corpus passes and six speech evaluations; the pass
requirement places the first scheduled eligible evaluation at 7,000 updates for
this corpus. Actual selected weights, audio likeness, completeness and CPU
streaming latency must be checked before replacing the accepted runtime student.

The exact local corpus/source/recipe and private submission receipts are retained
under `runtime/voice-data-expansion-20261004/`; they contain development artifacts
and are excluded from a portable release. Original cast recordings, accepted
weights, final inputs and listening samples remain available. October 4 cleanup
removed **42.924 GB** of retired smoke checkpoints, rejected pilot weights, old
caches, obsolete input archives and duplicate verification models. The receipt
is `runtime/cleanup-retired-20261004/result.json`; historical pilots may now need
their retired weights rebuilt or downloaded again.

## Historical OmniVoice pilot

**October 1 follow-up:** the user chose to continue with reference-based voices
and defer LoRA. The actual Judy adapter is 107,596,368 bytes (102.61 MiB), including
audio embedding/output layers; 62 equal-sized adapters would add 6.21 GiB before
the shared model/runtime. The limited 18.8-minute, 100-step pilot is not proof
against better-data training. No new dataset/training run was started in this
follow-up. The production route remains one shared base model with references.

**September 28 decision:** further datasets and training are deferred at the user's request. The live implementation uses the base OmniVoice model with the three existing Johnny/Judy/Panam references. The experiments below are preserved as history; the rejected Judy fine-tune is excluded from production. See [LOCAL_VOICES.md](LOCAL_VOICES.md).

The user prefers spending extra time preparing character voices, including real
training, to improve likeness and delivery. OmniVoice was preferred over
Chatterbox. The existing OmniVoice listening samples used the user-shared
VoiceStudio repository. This work adds an offline preparation stage for its
underlying OmniVoice model.

## Reproducible pilot

- Official training source: `k2-fsa/OmniVoice`, revision
  `08be0b4ccbac3e13e374e86fbfead4b4cac343e2`, separate checkout under ignored
  `vendor/reference-omnivoice-training`.
- Base weights: cached `k2-fsa/OmniVoice`, revision
  `c5fdb5ccb189668d56333f77ba2629f4cd7535f4`. Base files are read-only.
- Torch 2.8.0+cu128, Transformers 5.3.0, PEFT 0.21.0. Complete environment receipt:
  `runtime/voice-training/environment.txt`.
- [Official LoRA documentation](https://github.com/k2-fsa/OmniVoice/blob/08be0b4ccbac3e13e374e86fbfead4b4cac343e2/docs/lora_finetuning.md)
  describes adapters, inference and merging into an ordinary model directory.
  VoiceStudio accepts such a local directory through `OMNIVOICE_MODEL`.
  The checkpoint-100 merge loaded in the actual VoiceStudio service and rendered
  a 2.88-second raw reply successfully in 5.52 seconds. This proves compatibility,
  not an improvement in voice quality.

## Dataset gates

`scripts/Prepare-VoiceTraining.py` queries only explicit speaker names, selects
up to 240 dialogue clips per character and extracts them from the installed game
in batches of 32. No game assets are modified. All recordings, transcripts,
token caches and weights remain private local files excluded from Git.

Speaker/scene attribution comes from SoundDB metadata. Local archive SHA1,
decoded audio SHA256, exact subtitle text and duration are independently checked.
Filters exclude ambiguous speakers, phone/special delivery, clipped/silent
recordings and duplicate text/audio. These are screening checks, not a claim
that every recording has been listened to.

Connected scenes are kept together in training, development or final test data.
Scene overlap between splits is rejected. Round-robin selection avoids filling
the dataset with only one quest. Final test lines are not used for checkpoint
selection. The saved selection and file hashes identify the exact pilot corpus.

| Character | Training | Development | Final test |
| --- | ---: | ---: | ---: |
| Judy | 191 clips / 18.8 min | 24 clips / 2.1 min | 24 clips / 2.1 min |
| Johnny | 186 clips / 18.8 min | 24 clips / 2.3 min | 24 clips / 2.7 min |
| Panam | 191 clips / 17.7 min | 24 clips / 2.0 min | 24 clips / 1.9 min |

Most Johnny stereo recordings have a +/-0.300-second difference from SoundDB's
duration hint. Local PCM frame counts and ffprobe agree, so their screening
tolerance is explicitly 0.35 seconds; six larger discrepancies remain excluded.
The other characters retain the 0.15-second tolerance. No audio is trimmed to
force it to match remote metadata.

Original PCM is retained without EQ, denoising, trimming, normalization or pitch
changes. Tokenization performs only the model-required mono conversion and
24 kHz resampling, in memory. A longer concatenated prompt is not substituted
for training.

## Training and comparison

`scripts/Train-CharacterVoice.py` uses the official model, sample processor,
padding collator and trainer. A small cached-token loader handles Windows paths
and avoids upstream multiprocessing lambdas. The initial run uses:

- Rank 16 LoRA, alpha 32, dropout 0.05, plus the upstream audio input/output
  layers. The live model reports 26,886,144 trainable parameters (4.20%).
- SDPA attention, bf16, one recording per batch, four-batch accumulation.
- 250 optimizer steps, learning rate 0.00005, five percent warmup, cosine decay.
- Development evaluation and resumable snapshots every 50 steps. Development
  masks use a fixed random seed; evaluation restores training RNG state.
- A bounded CUDA allocator budget, leaving at least 1 GiB of currently free
  device memory outside the worker. Other voice models are not placed on the GPU
  during training; auxiliary scoring can run on the CPU.

Lower development loss alone does not establish a better voice. Compare the
base and chosen adapter with the same reference, seed, new sentences and render
settings. Judge resemblance, pronunciation, pacing and long-sentence stability.
Training can overfit; do not automatically choose the last or longest run.

`scripts/Compare-CharacterVoice.py` renders three longer new sentences through
the pinned upstream model, with matched references and seeds for base/adapter.
This is an offline training comparison, distinct from the earlier VoiceStudio
HTTP samples. `scripts/Evaluate-VoiceSamples.py` supplements listening with
Whisper transcription and WavLM speaker similarity against eight development
recordings. Those metrics cannot establish acting quality or guarantee likeness.
The model revisions and per-recording scores are saved with each comparison.

The original Judy reference scores 0.936 against these development voices;
the earlier user-heard VoiceStudio greeting scores 0.904, with zero word errors
in Whisper's transcription. These are diagnostic baselines, not acceptance
thresholds or proof that one voice sounds better.

The adapters are experimental. Production remains on Convai/Kokoro until a
local voice passes listening review and native playback. New speech will need
its own subtitle/facial timing. No lip-sync completion is implied here.

## Listening decision: retain the base model

On September 28 the user preferred base OmniVoice over the trained Judy sample.
The pilot was paused for review after checkpoint 100 of the planned 250 steps;
the full 250-step run did not complete. The adapter is rejected for deployment,
and no further training is scheduled for this recipe. Johnny and Panam have
prepared datasets but have not been trained.

Development loss fell from 3.675 to 3.595, while average WavLM similarity on three
new sentences fell from 0.9195 (base) to 0.9141 (trained). These measurements did
not justify overriding the user's listening result. Comparison audio and receipts
remain under ignored `runtime/voice-training`. The rejected adapter, merged model
and optimizer/checkpoint weights were removed in the October 4 disk cleanup.
Replaying this historical pilot now requires rebuilding its weights. The cleanup
receipt is `runtime/cleanup-retired-20261004/result.json`.

The comparison loader restricts LoRA merging to the speech model: it temporarily
detaches the audio tokenizer before matching attention-layer names, then restores
it. Missing adapter weights are treated as an error. The corrected comparison
loaded without missing-weight warnings. Complete receipts are under
`runtime/voice-training/judy-alvarez/checkpoint-100-reviewed`.

This September comparison is historical. The current mod uses the accepted
shared Pocket student by default, with OmniVoice and Convai still available.
The expanded A teacher is training on Kaggle and will be followed by student
distillation; see [current voice findings](VOICE_MODEL_RESEARCH_2026-10-03.md).
The rejected Judy adapter is not part of that pipeline.

## Commands

These commands describe the retired OmniVoice experiment. They require restored
training dependencies and generated assets if those files have been cleaned up.

From the workspace, use the isolated training interpreter:

```powershell
& .\vendor\reference-omnivoice-training\.venv\Scripts\python.exe scripts/Prepare-VoiceTraining.py --keys judy-alvarez --limit 240
& .\vendor\reference-omnivoice-training\.venv\Scripts\python.exe scripts/Train-CharacterVoice.py tokenize --key judy-alvarez
& .\vendor\reference-omnivoice-training\.venv\Scripts\python.exe scripts/Train-CharacterVoice.py train --key judy-alvarez --steps 250 --label pilot-v1
```

An existing training directory requires an explicit resume checkpoint or a new
run label. Inspect `dataset-report.json`, `evaluation.jsonl`, `provenance.json`
and `completed.json`; a started process or a checkpoint file alone is not proof
that the pilot completed or improved audible quality.
