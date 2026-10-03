# Voice cloning findings and Convai API handoff

**3 October 2026.** One document covering our cloning experiments, teacher fine-tuning, student distillation, listening samples, resource measurements and proposed API design. Audio, code and evidence are in the subfolders linked below. Dev-slot deployment and infrastructure instructions are outside this handoff.

## 1. Recommended offerings

| Offering | Customer supplies | Convai handles | Runtime | Justification |
| --- | --- | --- | --- | --- |
| Stock Pocket TTS cloning | A usable reference recording and desired language | Validate audio; prepare/cache voice state | Shared CPU model with incremental PCM | Low setup burden; no customer-specific training |
| Managed tuned Pocket TTS cloning | Recordings with speaker labels; optional transcripts | Data preparation, alignment, teacher adaptation, student distillation, evaluation and model publication | Small CPU student plus reference states | Upfront work to improve quality for a particular cast/domain |

These are sensible choices. **Training is a quality upgrade.** Stock and tuned Pocket students have similar architecture and CPU requirements; tuning does not automatically make inference cheaper than stock Pocket.

The user approved our latest student for Johnny, Judy and Panam and requested that it replace OmniVoice in the mod. This supports using the student for those tested voices. It does not establish universal parity across customers, accents, languages or emotional performances.

“Cheap” remains a pricing hypothesis until server throughput, RAM residency, queueing and total cost are measured. The current evidence shows CPU inference with zero model VRAM, rather than a measured cloud price.

### Important additions to the original proposal

- No-training cloning still needs a suitable reference and one-time preparation.
- A voice reference profile, trained model and character conversation profile are separate resources.
- A shared custom model can cover several speakers; a full model per character is unnecessary.
- Customer training needs held-out evaluation and a way to report insufficient data or no improved candidate.
- Warm models and cached reference states are essential to latency.
- Our custom checkpoint is English. Language support needs per-model qualification.
- Omni's released weights have commercial restrictions. Section 10 addresses training, forks and Chris's optimizations.

## 2. How Pocket cloning works

### Reference conditioning

Pocket encodes reference audio into a reusable conditioning state. New text and that state drive the shared model. It needs audio rather than a matching transcript for inference. Prepare the state once and copy its request-local autoregressive state for independent generations. [Python API](https://kyutai-labs.github.io/pocket-tts/API%20Reference/python-api/)

There is one neural model for many voices. Our adaptation used 72 speakers in a shared model. References select voice identity/style at inference; fine-tuning changes the learned weights.

Pocket generates continuous audio latents sequentially and decodes them with Mimi. The public generator yields PCM while later audio continues generating. [CALM paper](https://arxiv.org/abs/2509.06926), [pinned implementation](https://github.com/kyutai-labs/pocket-tts/blob/41cbc84af539ea78a804ffca5f9c6edc1a22ce44/pocket_tts/models/tts_model.py)

### Fine-tuning and distillation

We adapted a larger teacher, then transferred its behavior into a six-layer student. Reference conditioning remains part of inference.

| Model | Backbone | Exported elements, including buffers | FP32 export bytes |
| --- | --- | ---: | ---: |
| Tuned teacher | 24 layers, width 1024 | 336,068,290 | 1,344,315,200, about 1.25 GiB |
| Approved student | Six layers, width 1024 | 109,502,146 | 438,033,312, about 418 MiB |

The student is the intended inference artifact; the teacher is a training/listening reference. Both include the same frozen Mimi codec. The actual student parameter count, excluding buffers, is 109,501,826.

Stock September weights are about 219 MB in lower-precision serialized storage. Our export is FP32; its larger file does not mean twice as many parameters. Weight file size and process RAM are also different measurements.

The published depth recipe copies non-backbone components and trains a shallower backbone. [Official distillation configuration](https://github.com/kyutai-labs/pocket-tts/blob/41cbc84af539ea78a804ffca5f9c6edc1a22ce44/training/configs/depth_distill.yaml)

### Cache identity

Conditioning should be keyed by account/voice, model version, exact audio hash and preprocessing version. Recompute it after a weight change. Upstream explicitly prevents mixing stock prepared named voices with custom weights, which can produce incompatible generation or missing termination. [Conditioning checks](https://github.com/kyutai-labs/pocket-tts/blob/41cbc84af539ea78a804ffca5f9c6edc1a22ce44/pocket_tts/models/tts_model.py)

## 3. Listening tables

Links point into this folder. WAV bytes are unchanged; [audio-manifest.json](references/audio-manifest.json) records source, exact text, reference hash, sampler settings and output hashes.

Teacher uses CFG 2/two decoder steps; stock/student use CFG 1/one step. Temperature is 0.3, seed 1337 plus text index. These examples are not a uniformly held-out, blinded cross-engine benchmark.

### Matching novel sentences

These prompts match across stock, teacher and student for each voice:

| Character | Test text | Stock Pocket | Tuned teacher | Approved student |
| --- | --- | --- | --- | --- |
| Johnny | The city is quiet tonight, but I know trouble is waiting somewhere. | [Listen](audio/pocket-stock/johnny-01.wav) | [Listen](audio/pocket-teacher/johnny-01.wav) | [Listen](audio/pocket-student/johnny-01.wav) |
| Johnny | We should find a safe place to stop before we talk about the plan. | [Listen](audio/pocket-stock/johnny-02.wav) | [Listen](audio/pocket-teacher/johnny-02.wav) | [Listen](audio/pocket-student/johnny-02.wav) |
| Judy | The city is quiet tonight, but I know trouble is waiting somewhere. | [Listen](audio/pocket-stock/judy-01.wav) | [Listen](audio/pocket-teacher/judy-01.wav) | [Listen](audio/pocket-student/judy-01.wav) |
| Judy | We should find a safe place to stop before we talk about the plan. | [Listen](audio/pocket-stock/judy-02.wav) | [Listen](audio/pocket-teacher/judy-02.wav) | [Listen](audio/pocket-student/judy-02.wav) |
| Panam | The city is quiet tonight, but I know trouble is waiting somewhere. | [Listen](audio/pocket-stock/panam-01.wav) | [Listen](audio/pocket-teacher/panam-01.wav) | [Listen](audio/pocket-student/panam-01.wav) |
| Panam | We should find a safe place to stop before we talk about the plan. | [Listen](audio/pocket-stock/panam-02.wav) | [Listen](audio/pocket-teacher/panam-02.wav) | [Listen](audio/pocket-student/panam-02.wav) |

### Original game lines and synthesized versions

Johnny: “My man, Dex DeShawn. How's that quiet life workin' out for you now, choom?”

Judy: “I always had a techie streak, ever since I was a little kid. When I felt my first virtu, I was like, ‘Hey, I can make this way better.’”

Panam: “It was completely dark, empty. Not a star in the sky. All I heard was the wind and a few engines in the distance.”

| Character | Original game recording | Stock Pocket | Tuned teacher | Approved student |
| --- | --- | --- | --- | --- |
| Johnny | [Original](audio/original-game/johnny.wav) | [Listen](audio/pocket-stock/johnny-00.wav) | [Listen](audio/pocket-teacher/johnny-00.wav) | [Listen](audio/pocket-student/johnny-00.wav) |
| Judy | [Original](audio/original-game/judy.wav) | Different text: see below | [Listen](audio/pocket-teacher/judy-00.wav) | [Listen](audio/pocket-student/judy-00.wav) |
| Panam | [Original](audio/original-game/panam.wav) | Different text: see below | [Listen](audio/pocket-teacher/panam-00.wav) | [Listen](audio/pocket-student/panam-00.wav) |

Judy's/Panam's originals are also their conditioning recordings, so this panel includes reference-content overlap. Johnny's original comparison line is separate from his joined 22-second reference. Use the novel sentences above to judge new wording.

The stock run used Johnny's index-zero text for all three speakers. Additional stock readings, explicitly with that different text: [Judy](audio/pocket-stock/judy-00.wav), [Panam](audio/pocket-stock/panam-00.wav).

### More teacher/student samples

Column prompts:

1. “If you want the truth, ask one question at a time.”
2. “Take the next left, then stop when we reach the bridge.”
3. “Can you see the bridge, or is it hidden behind that truck?”

| Character | Truth / one question | Next left / bridge | Bridge / truck |
| --- | --- | --- | --- |
| Johnny | Teacher [Listen](audio/pocket-teacher/johnny-03.wav) · Student [Listen](audio/pocket-student/johnny-03.wav) | Teacher [Listen](audio/pocket-teacher/johnny-04.wav) · Student [Listen](audio/pocket-student/johnny-04.wav) | Teacher [Listen](audio/pocket-teacher/johnny-05.wav) · Student [Listen](audio/pocket-student/johnny-05.wav) |
| Judy | Teacher [Listen](audio/pocket-teacher/judy-03.wav) · Student [Listen](audio/pocket-student/judy-03.wav) | Teacher [Listen](audio/pocket-teacher/judy-04.wav) · Student [Listen](audio/pocket-student/judy-04.wav) | Teacher [Listen](audio/pocket-teacher/judy-05.wav) · Student [Listen](audio/pocket-student/judy-05.wav) |
| Panam | Teacher [Listen](audio/pocket-teacher/panam-03.wav) · Student [Listen](audio/pocket-student/panam-03.wav) | Teacher [Listen](audio/pocket-teacher/panam-04.wav) · Student [Listen](audio/pocket-student/panam-04.wav) | Teacher [Listen](audio/pocket-teacher/panam-05.wav) · Student [Listen](audio/pocket-student/panam-05.wav) |

### Actual local CPU-streamed outputs

These raw Johnny WAVs came from the paired public streaming-generator benchmark:

| Previous accepted student | Approved new student |
| --- | --- |
| [Listen](audio/cpu-streaming/johnny-accepted.wav) | [Listen](audio/cpu-streaming/johnny-candidate.wav) |

Cloud training-sampler output and public CPU-generator output can differ even with matching text/seed. Their provenance remains separate; training-rollout WAVs were not substituted for selected-model final evaluations.

## 4. Reference experiments

We tried a short Johnny reference, then joined clean lines into longer recordings. The user preferred the 22-second version's pacing; 30 seconds did not establish another improvement.

| Reference | Generated audio | First PCM | Complete generation | Audio duration | Reference preparation |
| --- | --- | ---: | ---: | ---: | ---: |
| Original 8.34 s | [Listen](audio/reference-experiments/pocket-reference-test-20261002-00.wav) | 199.75 ms | 2.230 s | 4.56 s | 2.137 s |
| Joined 22.29 s | [Listen](audio/reference-experiments/pocket-reference-test-20261002-01.wav) | 193.86 ms | 2.976 s | 6.40 s | 7.330 s |
| Different 7.79 s | [Listen](audio/reference-experiments/pocket-reference-test-20261002-02.wav) | 184.52 ms | 3.145 s | 7.04 s | 1.935 s |
| Joined 30.00 s | [Listen](audio/reference-experiments/pocket-30s-reference-20261002-00.wav) | 210.08 ms | 2.430 s | 5.28 s | 10.532 s |

These were standalone CPU experiments, separate from the final live-game conditions. First PCM excludes reference preparation and audio-device playback. Different output durations make generation time alone an incomplete comparison.

The [accepted conditioning recording](audio/conditioning/johnny-22s.wav) and reference-experiment outputs are included. Their paths/settings are in the audio manifest.

Try several clean references from the desired delivery, compare novel speech, then cache the best state. Longer audio adds preparation/storage/state cost and is not monotonically better. Pocket's optional 30-second truncation is disabled by default; it is not a required target length. [Voice-state API](https://kyutai-labs.github.io/pocket-tts/API%20Reference/python-api/)

## 5. Measured latency and resources

### Paired student test

Cyberpunk was running; the user stood still in unpaused gameplay. Workers ran sequentially through WSL on i9-13980HX, FP32, two intra-op threads and one inter-op thread. Windows reported Balanced; OEM Silent/Balanced/Turbo was unverified. Disk caches were retained.

| Measurement | Previous student | Approved new student |
| --- | ---: | ---: |
| Warm first PCM yield, five-call mean | 159.76 ms | 140.38 ms |
| Warm first copied PCM ready | 160.08 ms | **140.62 ms** |
| Warm first-yield range | 143.66–179.93 ms | 126.05–156.99 ms |
| Complete generation of 7.28-second line | 4.121 s | **3.803 s** |
| Fresh-process launch to first PCM | 31.318 s | **29.381 s** |
| Peak process RAM | 1.686 GiB | **1.687 GiB** |
| Model GPU allocation | 0 | **0** |
| Ideal sustained-speech onset estimate | 0.846 s | **0.826 s** |

New cold setup included about 7.17 s imports, 17.28 s model loading and 3.64 s reference preparation. This is process-cold, rather than a cold boot or first download.

**140 ms is PCM readiness, not recorded audible speech onset.** Both waves contain about 0.686 s of low-energy prefix. The onset estimate uses two sustained 20-ms RMS windows above −45 dBFS. It excludes Convai, queueing, IPC/network, game dispatch, buffering and the audio device.

All twelve streams ended naturally; exports stayed unchanged and owned workers exited. [Verified results](references/cpu-streaming-result.json)

Generation RTF was about 3.803 / 7.28 = **0.522**, faster than playback for one stream. This does not establish concurrent-session capacity or cloud cost.

### Stock baseline and current integration boundary

Stock short-reference Pocket yielded warm first PCM around 185 ms and generated 4.56 s of audio in approximately 2.04–2.10 s. Its reference/runtime/thread context differed, so this is not a controlled fine-tuning speed comparison.

The WSL model path worked. Native Windows IPC checks separately hit their 180-second startup deadline before model readiness and produced no neural/audio receipts. Causal controls localized this to the early blocking stdin reader during NumPy initialization: both TextIO and blocking Win32 reads stalled; polling with PeekNamedPipe before reading available bytes completed the same import/thread-setter control in 14.38 s. The production correction and full native worker proof are additional integration work. Those failures are not the synthesis latency of the successfully measured model.

Mod activation and complete cloud SSE/WebRTC acceptance remain separate work.

## 6. Our data and training methods

### Corpus and validation

**1,744 clips, 72 speakers, 8,582.81 seconds—143.05 minutes.** Johnny has 122 clips, Judy 158 and Panam 499, together 44.67% of uniform recording draws. Sparse voices may have one clip; coverage is unequal.

| Panel | Clips | Meaning |
| --- | ---: | --- |
| Unseen-scene development | 42 / five voices | Generalization across held-out scenes |
| Conditional development | 55 / 54 voices | New utterances from already seen scenes |
| Preserved regression | 94 | Detect damage to prior speech |
| Final test | 76 | Independent final objective comparison |

Native actor/scene/localization/audio joins established identity and text. We preserved source captions, held-out/history/reference exclusions, verified decoded audio, and used forced alignment plus independent CTC/Whisper evidence. A T-Bug row mishandling “Ramón” was withheld rather than automatically rewriting its caption.

Alignment estimates where supplied words fit; it does not prove they were spoken. File-edge silence also does not establish supervised silent targets: upstream word-gap segment cuts must be inspected. An 80-ms codec-boundary guard was investigated, but not adopted as blanket trimming.

The full decoded/latent cache gate passed before updates. Model/source identity, codec and calibration were checked against actual bytes and encoded rows.

### Teacher improvement pass

Warm start: our previously accepted adapted teacher. Fresh optimizer; learning rate 1e-5; 250-update warm-up; EMA 0.999; effective batch 64 on two T4s; qualified FP16 activations with FP32 masters/reductions. A 2,000-update bound and held-out plateau policy stopped the pass at 1,250; selected **EMA 500**.

The user preferred two-step teacher speech and approved the improved teacher. Earlier training/data preparation preceded this pass; these counts are not total scratch-to-final cost.

### Student transfer pass

Warm start: the mature previously accepted six-layer student backbone. We copied and froze the improved teacher's sampler/EOS heads, then used a fresh optimizer, LR 5e-5, 250-update warm-up, EMA 0.999 and effective batch 64. Micro-batch four across two GPUs retained the intended global batch.

The learning schedule remained 200,000 updates, with an independent 2,000-update execution cap. It was not compressed to decay to zero during the short pilot. All 2,000 updates completed; selected **EMA 1,500**.

Teacher speech uses CFG 2/two decoder steps; student uses CFG 1/one. Sampling steps, optimizer updates and dataset epochs are different quantities.

### Selection

| Student panel | Hybrid update zero | Selected 1,500 |
| --- | ---: | ---: |
| Unseen-scene speaker-macro MSE | 0.0703013 | 0.0536907, 23.63% lower |
| Conditional speaker-macro MSE | 0.0742409 | 0.0519776, 29.99% lower |
| Original 94-clip MSE | 0.0423101 | 0.0422846 |

Hybrid zero already has new teacher heads; the original accepted student is an independent control. Final 76-clip original/new MSE was **0.0405275 / 0.0401581**. Teacher flow/EOS loss and student MSE are different objectives.

All eighteen selected speech probes were finite and naturally terminated, with no tentative ASR deletions. Numeric selection and human listening approval were separate.

Corrections included mature initialization, suitable EMA for a bounded run, pooled loss denominators across accumulation/DDP, frozen latent calibration, and exact head/codec checks before and after serialized export. A flattened selected-EMA checkpoint was imported directly, without inventing a second EMA overlay.

### Customer adaptation

Use the released teacher and qualified customer data for first adaptation, then the published depth-distillation route. Our warm-start transfer is useful where a qualified student already exists; it does not promise every first job needs only 2,000 updates.

Upstream supports Linux training and consumer-GPU accumulation setups around 16 GB. Its hundreds/thousands of hours guidance concerns foundational/new-language training, rather than a demonstrated minimum per customer voice. Set pilot budget from coverage and held-out speech. [Training guide](https://github.com/kyutai-labs/pocket-tts/blob/41cbc84af539ea78a804ffca5f9c6edc1a22ce44/training/README.md), [depth configuration](https://github.com/kyutai-labs/pocket-tts/blob/41cbc84af539ea78a804ffca5f9c6edc1a22ce44/training/configs/depth_distill.yaml)

Convai can handle format preparation, speaker labels/separation, ASR/transcript review, alignment, split construction and training. Ambiguous rows should be withheld or returned for correction. Jobs should report insufficient coverage or no improved candidate when appropriate.

## 7. Cost and inference advice

Stock: reference setup/storage plus inference. Managed tuned: preparation/training/qualification plus inference and custom-model residency. Relative to stock, the training purchase is quality.

One custom cast/tenant may need one roughly 418-MiB FP32 student artifact plus its voice states. It does not need that artifact for each voice. Resident RAM was larger than disk weights; measure idle capacity and tenant/model switching.

Against a more expensive alternative, break-even audio minutes equal upfront preparation/training cost divided by the positive difference in inference cost per audio minute. Stock/tuned Pocket should not be assumed to have different inference costs solely from fine-tuning.

Measure server p50/p95 first PCM, sustained speech onset, complete generation, CPU time, RAM, RTF and concurrent queueing. Include warm model/cold voice and cold model. Laptop measurements are a starting workload.

Useful engineering:

- Keep model resident; prepare/cache references ahead of synthesis.
- Bind states to model versions and copy request-local generation state.
- Bound CPU threads, queueing and concurrent execution.
- Stream PCM prefixes; distinguish source completion from client playback completion.
- Use monotonic sample offsets and exact request/voice/model ownership.
- Keep optional alignment/lip-sync analysis from delaying initial audio.
- Evaluate precision or waveform changes separately from the faithful baseline.

Our measured CPU route used FP32 without TensorRT, FP8 or FP4.

## 8. Proposed Core API design

This is a proposed contract, not an implemented Convai endpoint schema. [Example JSON](code/service-contract.example.json)

| Resource | Required purpose |
| --- | --- |
| Voice profile | Account owner, reference asset/hash, language, engine, model/conditioning versions, readiness |
| Training job | Dataset/speaker labels; stages qualify → align → encode → fine-tune → distill → evaluate → publish |
| Model version | Weights/config/tokenizer hashes, lineage, languages, codec/calibration identity, sampling and evaluation |
| TTS request | Exact request and voice/model version, text, language and transport |

Use one Pocket adapter with stock/custom model versions. Keep model execution independent of Core conversation orchestration, with account capability flags and an interface usable by cloud or on-prem callers.

Customer flow:

1. Upload a reference, or a labeled training collection.
2. Prepare stock conditioning, or qualify/train/distill/evaluate a custom student and prepare conditioning with its weights.
3. Publish a ready voice key in the Core registry. Character create/update should reference it through the verified voice-selection schema; the existing creation field is voiceType, so confirm new key format rather than invent a current API field.
4. Freeze voice/model versions at admission. Upgrades affect later requests.

Keep backstory, speaking_style_description and speaking_style_sample_dialogues separate. Example dialogue contains spoken text without speaker-name prefixes. Personality is dialogue-generation context; voice preparation does not seed character memory.

SSE should carry negotiated PCM prefixes and sample-offset metadata. WebRTC can encode the same produced audio into its negotiated track. Source completion follows sealed generation; playback completion follows the client clock. Optional facial/subtitle metadata uses actual sample timing. Cancellation retires the exact producer and queued output.

Clone preparation should be reusable/asynchronous. It need not generate an invented conversation as a warm-up.

Prove upload → ready voice → novel text → streamed audio for both transports, and upload → teacher → student → ready model for the managed tier. Validate stale versions, state isolation, language selection, cancellation and concurrency. Measure the complete API boundary separately. No cloud deployment was performed here.

## 9. Included code, identities and terms

- [Streaming example](code/pocket_streaming_example.py): complete text once, public PCM iterator, independent state. Local example rather than a full service.
- [Training runner](code/pocket_training/runner.py), [data qualification](code/pocket_training/teacher_data.py), [student transfer](code/pocket_training/student_transfer.py), copied package/tests.
- [CPU measurements](references/cpu-streaming-result.json), [teacher selection](references/teacher-selection.json), [student selection](references/student-selection.json), [data coverage](references/training-data-coverage.json), [export receipt](references/student-export-receipt.json), [approval](references/student-user-approval.json).
- [Pinned Pocket source license](references/LICENSE-PocketTTS.txt) and [handoff verification](references/handoff-verification.json).

Local streaming example, using a prepared environment and a custom YAML for the selected model:

    python code/pocket_streaming_example.py --config /path/to/inference.yaml --reference audio/conditioning/johnny-22s.wav --text "The city is quiet tonight." --output /new/path/stream.wav

The example exposes first yielded/copied PCM and setup timing. It has syntax/CLI verification; the actual model benchmark was performed by the separate measured harness represented in the results.

The copied training wrappers require the pinned upstream training package and qualified assets. Weights, credentials and the full training dataset are not bundled. Audio is the selected listening set.

| Component | Pin |
| --- | --- |
| Pocket source | 41cbc84af539ea78a804ffca5f9c6edc1a22ce44 |
| Stock English weight revision | 983151f13aaeab1b13c1e5e3c2c383d49a9edf3f |
| Stock weight SHA256 | fb0dc01b0d4d2e1c905b7a3e0676e3d9c96d5ae460e24e3ab94981805babf997 |
| Teacher SHA256 | 95d91ae4b970e51bc6270326dccf1294d576f9cb9df4f9667ebb2838c7cb0d27 |
| Student SHA256 | 373a0df2115b1e5dc1c583bb0033838ba4ae337499831261e3938218d239a391 |
| Student input identity | a881e3024512339c5c601219f4e453370a6769a2e59e6f8750cdc37c110fc152 |

Pocket v3.3.0 was checked. Current configs cover English, French, German, Portuguese, Italian, Spanish and Dutch; the HF language list lags Dutch. Our trained model is qualified for English. [Release](https://github.com/kyutai-labs/pocket-tts/releases/tag/v3.3.0), [language configs](https://kyutai-labs.github.io/pocket-tts/CLI%20Commands/generate/)

Code is MIT; official weights declare CC-BY-4.0 with gated cloning terms. Retain attribution/model terms and use authorized customer data. [Code license](https://github.com/kyutai-labs/pocket-tts/blob/41cbc84af539ea78a804ffca5f9c6edc1a22ce44/LICENSE), [weight terms](https://huggingface.co/kyutai/pocket-tts)

## 10. OmniVoice commercial-use clarification

Omni code is Apache-2.0; its released speech weights are CC-BY-NC. Fine-tuning or conversion to TensorRT/FP8 does not establish commercial rights. Chris optimized existing inference with TensorRT, memory sharing and precision changes; his reports do not document training a replacement model. [Official license](https://huggingface.co/k2-fsa/OmniVoice/blob/c5fdb5ccb189668d56333f77ba2629f4cd7535f4/README.md)

Real training code is published. Fresh initialization uses Qwen3-0.6B text weights and new audio components, avoiding the released Omni speech checkpoint. The default tokenizer has separate Boson Community License terms; original Emilia in the example has noncommercial data terms. Commercial qualification therefore requires appropriate data, tokenizer/components and trained weights. [Trainer](https://github.com/k2-fsa/OmniVoice/blob/08be0b4ccbac3e13e374e86fbfead4b4cac343e2/omnivoice/training/trainer.py), [builder](https://github.com/k2-fsa/OmniVoice/blob/08be0b4ccbac3e13e374e86fbfead4b4cac343e2/omnivoice/training/builder.py), [Qwen](https://huggingface.co/Qwen/Qwen3-0.6B), [tokenizer license](https://huggingface.co/bosonai/higgs-audio-v2-tokenizer/resolve/815a03f1b57dcb5ae918db415f22cd0c8a6f0f54/LICENSE), [data terms](https://huggingface.co/datasets/amphion/Emilia-Dataset)

The paper's original experiments used eight H800s, reporting 1.33/9.66 days for bilingual/multilingual training; the full multilingual corpus was 581,000 hours. These describe original experiments, rather than a budget estimate for customer adaptation. [Training details](https://arxiv.org/html/2604.00688v1#S3.SS3)

### What commercial-use research found

No free, commercially qualified Omni checkpoint was verified in this search. The authors attribute the restriction to rights in their training data, including original Emilia and WenetSpeech-Yue. They say they cannot grant commercial rights to those existing weights, and plan a commercially usable checkpoint without a confirmed timeline. This is a data-rights constraint on the released checkpoint; it should not be described as opposition to commercial adoption. On 7 September the author confirmed no commercial checkpoint was currently available. [September author reply](https://github.com/k2-fsa/OmniVoice/issues/258#issuecomment-5565297920), [July author reply](https://github.com/k2-fsa/OmniVoice/issues/235#issuecomment-5126307191), [official discussion](https://huggingface.co/k2-fsa/OmniVoice/discussions/37)

| Route found online | Evidence and status |
| --- | --- |
| Apache-labelled AEmotionStudio mirror | Its main weight file has the same public LFS SHA256 as official Omni: 730839316de585f4c8298ec0e1712efc10fb19c6fa4e36eb741cb8d51ebcf6aa, 2,450,344,112 bytes. The label does not establish an independent commercial checkpoint. [Mirror](https://huggingface.co/AEmotionStudio/omnivoice-models) |
| MLX and GGUF conversions | Derived from official weights; format conversion supplies no new weight rights. The GGUF card explicitly retains CC-BY-NC. [MLX](https://huggingface.co/mlx-community/OmniVoice-4bit), [GGUF](https://huggingface.co/Serveurperso/OmniVoice-GGUF) |
| Vietnamese fine-tunes | Base-model lineage remains official Omni; an Apache metadata label does not establish commercial permission. [Example](https://huggingface.co/splendor1811/omnivoice-vietnamese) |
| Genpio Voices | Claims independent initialization, commercial training corpora and DAC replacing Higgs. Its card requires separately agreed commercial terms and says access approval alone does not sublicense commercial use. Potential licensed alternative, not a verified free option. [Card](https://huggingface.co/GuidenAI/genpio_voice) |
| Paid hosted Omni services | Pricing or a marketing claim alone does not establish their exact checkpoint or upstream permission. Private agreements may exist; this search did not verify them. |

Search covered author licensing issues/discussions, metadata for 60 popular Omni-named HF models, representative mirrors/conversions/fine-tunes, the independent-retrain claim and provider statements. It supports “none verified in these sources,” rather than a claim about every private arrangement.

Possible future routes are a qualified author release, a separately licensed independent retrain, or fresh training with commercially usable data/components. The current Pocket implementation remains the concrete candidate.

### Pocket commercial scope

Pocket's weight license permits commercial use with attribution; its code uses MIT. Gated cloning conditions and uploaded-audio rights remain applicable. Our Cyberpunk-trained checkpoint and included game clips are evaluation evidence; the managed commercial service should train on authorized customer data. [Pocket weight terms](https://huggingface.co/kyutai/pocket-tts), [CC-BY-4.0 permissions](https://creativecommons.org/licenses/by/4.0/)

## 11. Next implementation work

1. Stock reference upload/conditioning and real PCM streaming behind the common TTS interface.
2. Managed qualification, teacher adaptation, student distillation and explicit version promotion.
3. Both API transports, multiple voices/novel texts, cancellation and realistic concurrent load.
4. Pricing from those measurements, with language/model capabilities visible to customers.

The evidence supports a Pocket prototype and managed tuning path. It provides approved example voices and measured CPU behavior; server economics and complete Core API acceptance remain to be demonstrated.
