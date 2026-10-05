# Voice cloning findings and Convai API handoff

**3 October 2026, updated 5 October 2026.** One technical document covering our cloning experiments, teacher fine-tuning, student distillation, resource measurements and proposed API design. Code and evidence are in the subfolders linked below. Dev-slot deployment and infrastructure instructions are outside this handoff.

**Not included:** reference recordings, generated audio samples and model weights/checkpoints. The listening clips were removed from this folder on 5 October 2026 to keep it technical; the manifests in `references/` still record each removed clip's source, text, reference hash, sampler settings and output hash. Section 12 has the October 5 teacher-continuation results.

## 1. Recommended offerings

| Offering | Customer supplies | Convai handles | Runtime | Justification |
| --- | --- | --- | --- | --- |
| Stock Pocket TTS cloning | A usable reference recording and desired language | Validate audio; prepare/cache voice state | Shared CPU model with incremental PCM | Low setup burden; no customer-specific training |
| Managed tuned Pocket TTS cloning | Recordings with speaker labels; optional transcripts | Data preparation, alignment, teacher adaptation, student distillation, evaluation and model publication | Small CPU student plus reference states | Upfront work to improve quality for a particular cast/domain |
| OmniVoice cloning, 32 or 16 steps | A short clean reference and its transcript, or ASR-prepared transcript | Prepare/cache clone prompt; synthesize through GPU adapter | Shared GPU model; 32 default, 16 faster | Quick setup without customer-specific training, with a quality/speed choice |

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
- Omni's 32/16 are inference sampling steps; they are not model precision or training epochs.

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

### OmniVoice zero-shot cloning

Omni uses a shared model and cached audio/text clone prompt. Its recommended reference is 3–10 seconds; matching reference text can be supplied or obtained through Whisper ASR. Cache that work before repeated synthesis. 32 sampling steps is the default; 16 is the documented faster option. The user preferred 32 in our early comparisons. [Official cloning usage](https://github.com/k2-fsa/OmniVoice#voice-cloning), [generation options](https://github.com/k2-fsa/OmniVoice/blob/08be0b4ccbac3e13e374e86fbfead4b4cac343e2/docs/generation-parameters.md)

Current public Omni generation returns completed waveform arrays. Its internal long-text chunking does not expose the same incremental PCM iterator as Pocket. A low-latency adapter can schedule stable text phrases or implement an earlier-audio path; that behavior must be measured separately. [Generation implementation](https://github.com/k2-fsa/OmniVoice/blob/08be0b4ccbac3e13e374e86fbfead4b4cac343e2/omnivoice/models/omnivoice.py)

## 3. Sample panels (audio not included)

These panels were judged by listening. The audio is not bundled; [audio-manifest.json](references/audio-manifest.json) records each clip's source, exact text, reference hash, sampler settings and output hash.

Teacher uses CFG 2/two decoder steps; stock/student use CFG 1/one step. Temperature is 0.3, seed 1337 plus text index. These panels are not a uniformly held-out, blinded cross-engine benchmark.

### Matching novel sentences

Stock Pocket, tuned teacher and approved student each read the same two prompts for Johnny, Judy and Panam:

1. “The city is quiet tonight, but I know trouble is waiting somewhere.”
2. “We should find a safe place to stop before we talk about the plan.”

### Actual mod inference path — October 3

Ten recordings used the actual production PocketVoice/native Windows worker and approved EMA1500 student. Earlier teacher/student listening clips used the training generator; its reference preparation, EOS handling and text grouping differ from the public streaming API. The model, precision and reference hashes are the same.

Sentence A: “The city is quiet tonight, but I know trouble is waiting somewhere.”

Sentence B: “We should keep moving. Tell me if you need a break.”

| Character | First playable PCM A / B |
| --- | ---: |
| Johnny | 300.3 / 285.8 ms |
| Judy | 189.8 / 196.1 ms |
| Panam | 210.2 / 243.8 ms |
| Jackie | 218.6 / 215.7 ms |
| Evelyn | 222.6 / 252.3 ms |

CPU FP32, two threads, temperature 0.3, CFG 1 and one decode step; production RNG and public EOS/text/prompt defaults are unchanged. The first 400 ms source prefix arrived in 375.1–532.3 ms. Fresh worker startup was 18.71 seconds, measured separately.

These timings include native worker/IPC costs with Cyberpunk running and end at finite PCM received by Node. Convai, browser/game dispatch and audible device onset are excluded. They are production-path observations, not a clean benchmark or a quality guarantee for every speaker. [Exact production sampling/reference/audio evidence](references/production-pocket-audio-manifest.json).

### Original game lines

The original-line panel compared each character's game recording with stock, teacher and student readings of the same text:

- Johnny: “My man, Dex DeShawn. How's that quiet life workin' out for you now, choom?”
- Judy: “I always had a techie streak, ever since I was a little kid. When I felt my first virtu, I was like, ‘Hey, I can make this way better.’”
- Panam: “It was completely dark, empty. Not a star in the sky. All I heard was the wind and a few engines in the distance.”

Judy's/Panam's originals were also their conditioning recordings, so that panel had reference-content overlap. Johnny's comparison line was separate from his joined 22-second reference. The stock run used Johnny's text for all three speakers. Use novel sentences to judge new wording.

### Further teacher/student prompts

1. “If you want the truth, ask one question at a time.”
2. “Take the next left, then stop when we reach the bridge.”
3. “Can you see the bridge, or is it hidden behind that truck?”

### CPU-streamed outputs and OmniVoice 32/16

The paired public streaming-generator benchmark (section 5) produced raw Johnny clips for the previous and the approved student. Cloud training-sampler output and public CPU-generator output can differ even with matching text/seed; training-rollout clips were not substituted for selected-model evaluations.

The OmniVoice comparison used “Keep your eyes open, V. We can talk while we walk.” for Johnny, Judy and Panam at 32 and 16 steps, as raw FP16 CUDA outputs without mastering, denoising or pitch effects. Timings are in section 10.

## 4. Reference experiments

We tried a short Johnny reference, then joined clean lines into longer recordings. The user preferred the 22-second version's pacing; 30 seconds did not establish another improvement.

| Reference | First PCM | Complete generation | Audio duration | Reference preparation |
| --- | ---: | ---: | ---: | ---: |
| Original 8.34 s | 199.75 ms | 2.230 s | 4.56 s | 2.137 s |
| Joined 22.29 s | 193.86 ms | 2.976 s | 6.40 s | 7.330 s |
| Different 7.79 s | 184.52 ms | 3.145 s | 7.04 s | 1.935 s |
| Joined 30.00 s | 210.08 ms | 2.430 s | 5.28 s | 10.532 s |

These were standalone CPU experiments, separate from the final live-game conditions. First PCM excludes reference preparation and audio-device playback. Different output durations make generation time alone an incomplete comparison.

The accepted conditioning recording (Johnny, joined 22.29 s) and these outputs are not included; their paths and settings are in the audio manifest.

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

The WSL model path worked. Early native Windows IPC checks hit a 180-second startup deadline before model readiness. Controls localized this to the blocking stdin reader during NumPy initialization: TextIO and blocking Win32 reads stalled; PeekNamedPipe followed by reads of available bytes completed the same control in 14.38 s.

After that correction, the native Windows worker loaded the approved student, streamed a complete reply, cancelled after two chunks, reused the same PID/cached reference with zero preparation time, and exited. This single check measured copied PCM 270.64 ms and Node receipt 304.54 ms; complete generation was 4.175 s for 7.44 s of audio. It is a separate setup, not the five-call WSL average. [Native worker proof](references/pocket-native-worker-proof.json)

The combined native student → muted Edge renderer → rolling Rhubarb/facial-prefix check also passed: playback began before source completion, final audio/face clock was 7.36 s, and no underruns occurred. It made no Convai session requests and closed the owned worker/browser. This establishes the actual local interface; audible/in-game and cloud API acceptance remain separate. [Integration proof](references/pocket-native-integration-proof.json)

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

Omni: reference/ASR preparation plus GPU inference, with 32/16 steps as a quality/speed choice inside one offering. It is reasonable to position it as a low-setup GPU tier, but “moderate cost” must come from measured GPU utilization, batching, shape caches and service volume.

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

Use a Pocket adapter with stock/custom model versions and an Omni adapter with 32/16 selection. Keep model execution independent of Core conversation orchestration, with account capability flags and an interface usable by cloud or on-prem callers. Normalize output timing/ownership while retaining each engine's genuine audio-availability boundary.

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
- [Omni cloning example](code/omnivoice_cloning_example.py): cached clone prompt and 32/16 complete generation.
- [Training runner](code/pocket_training/runner.py), [data qualification](code/pocket_training/teacher_data.py), [student transfer](code/pocket_training/student_transfer.py), copied package/tests.
- [CPU measurements](references/cpu-streaming-result.json), [teacher selection](references/teacher-selection.json), [student selection](references/student-selection.json), [data coverage](references/training-data-coverage.json), [export receipt](references/student-export-receipt.json), [approval](references/student-user-approval.json).
- [Pinned Pocket source license](references/LICENSE-PocketTTS.txt) and [handoff verification](references/handoff-verification.json).
- Chris's original [TensorRT report](references/chris-tensorrt-report.txt), [precision report](references/chris-precision-report.txt), their PDFs and code-only archives in references/.

Local streaming example, using a prepared environment and a custom YAML for the selected model:

    python code/pocket_streaming_example.py --config /path/to/inference.yaml --reference /path/to/reference.wav --text "The city is quiet tonight." --output /new/path/stream.wav

The example exposes first yielded/copied PCM and setup timing. It has syntax/CLI verification; the actual model benchmark was performed by the separate measured harness represented in the results.

The copied training wrappers require the pinned upstream training package and qualified assets. Weights, checkpoints, reference recordings, generated audio, credentials and the training dataset are not bundled.

Examples submit the complete text once and add no extra waveform effects. Pocket's upstream implementation can segment very long text internally and uses a small decoder-start fade; this is model/library behavior, separate from additional service/mod processing.

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

## 10. OmniVoice performance and optimization methods

Omni is a usable zero-shot GPU solution for the technical design. It needs no customer-specific training for reference cloning. Our local runtime used VoiceStudio's adapter with effects/mastering disabled, actual FP16 CUDA inference and no TensorRT.

| Local context | 32 steps | 16 steps |
| --- | ---: | ---: |
| RT Ultra / 60 FPS / Turbo: process-cold to first saved WAV | 17.46 s | 12.16 s |
| Same run, warm complete generation | 2.51–2.69 s | 1.38–1.39 s |
| Output duration | 6.56 s | 6.56 s |
| Peak engine VRAM reservation | 2.16 GiB | 2.16 GiB |
| Peak process-tree RAM | 3.35 GiB | 3.35 GiB |

These laptop results use RTX 4080 Laptop/i9-13980HX. Cold includes imports, load, reference handling, inference and saved-file receipt; warm excludes Convai and device playback. They are complete-wave measurements, so comparing 2.5 seconds with Pocket's 140-ms first PCM as if they were the same boundary would be misleading.

The six replay clips (not included) used a different shorter sentence. Actual complete-call times were:

| Character | 32-step generation | 16-step generation | Audio duration |
| --- | ---: | ---: | ---: |
| Johnny | 1,730.5 ms | 869.7 ms | 4.44 s |
| Judy | 1,705.9 ms | 867.1 ms | 2.96 s |
| Panam | 1,684.7 ms | 857.7 ms | 3.20 s |

Owning a persistent CUDA stream and bounded graph/output-buffer lifetime improved later replay performance. Our FP8 experiment modestly reduced generation time and allocated memory, but was not adopted because reserved-memory and perceptual benefits were not established.

### Chris's supplied TensorRT work

Chris optimized the existing learned model; his reports describe conversion, memory/tensor sharing and precision changes, rather than training replacement speech weights.

His precision report uses RTX 5090 / TensorRT 11.2.1.2, 32 steps, cached clone prompts and no concurrent game:

| Engine | Median complete-file clone latency | Reported device-wide used memory |
| --- | ---: | ---: |
| Original TensorRT | 321.3 ms | 13,398 MiB |
| Shared-memory FP16 | 316.5 ms | 5,600 MiB |
| FP8 | 270.5 ms | 5,036 MiB |
| NVFP4 | 257.8 ms | 4,850 MiB |

The separate TensorRT report measured PyTorch 818.2 ms versus original TensorRT FP16 322.9 ms. Different reports/runs explain that small baseline difference.

Useful methods: release replaced PyTorch transformer copies, reuse GPU input addresses, cache clone prompts, bound shape/CUDA-graph caches, and share scratch memory under serialized execution. Reported GPU-copy traffic fell roughly 97%. Shared-memory FP16 preserved the ten checked TensorRT WAVs; that does not prove TensorRT is identical to the original PyTorch output or that low precision preserves every human voice.

Times include dispatch through WAV writing and exclude load/reference/shape preparation. Memory is device-wide usage rather than process-only peak. These results are hardware/input specific and are not a streaming or cloud-price guarantee. Supplied reports and code references are in references/.

**License note, once:** released Omni weights are CC-BY-NC because of training-data rights, rather than opposition to commercial adoption; code is Apache-2.0. The authors plan a commercial checkpoint and currently cannot grant commercial rights to existing weights. Fresh training is possible, but data/tokenizer terms also need qualification; no free commercially qualified fork was verified in this search. [Official statement](https://huggingface.co/k2-fsa/OmniVoice/blob/c5fdb5ccb189668d56333f77ba2629f4cd7535f4/README.md), [author explanation](https://github.com/k2-fsa/OmniVoice/issues/235#issuecomment-5126307191)

## 11. Next implementation work

1. Stock Pocket reference upload/conditioning and real PCM streaming behind the common TTS interface.
2. Managed Pocket qualification, teacher adaptation, student distillation and explicit version promotion.
3. Omni cached cloning with 32/16 selection; evaluate Chris's GPU optimizations on the chosen runtime.
4. Both API transports, multiple voices/novel texts, cancellation and realistic concurrent load.
5. Pricing from those measurements, with language/model capabilities visible to customers.

The evidence supports a Pocket prototype and managed tuning path. It provides approved example voices and measured CPU behavior; server economics and complete Core API acceptance remain to be demonstrated.

## 12. October 5 update: expanded corpus and teacher continuation

### Corpus

The cast expansion froze **8,140 training clips across 79 voice identities**, with separate panels: unseen-scene development 75 clips (speaker-macro, used for checkpoint selection), conditional development 87, preserved regression 94 and final test 76 (excluded from selection). The approved runtime student in sections 2–6 predates this corpus and is unchanged.

### Recipe

Continuation of the teacher on the full corpus, from the selected A EMA500 initializer: learning rate 1e-5 constant after 1,000 warm-up updates, EMA 0.999, global batch 64 (micro-batch 4 on each of two T4s, FP16 activations). It planned up to 20,000 updates and only allowed plateau stopping after at least 8,000 updates, 50 corpus passes and 8 speech evaluations. Evaluation ran every 1,000 updates: held-out loss on the development panel plus a speech panel scored by ASR.

### Throughput on Kaggle (2× T4)

| Stage | Measured |
| --- | ---: |
| Input staging (copy and verify inputs) | ~19 min |
| Latent preparation (8,140 recordings) | ~30 min |
| Optimizer update | 1.8–2.1 s |
| Evaluation + 5.06 GB checkpoint + private bucket upload, per 1,000 updates | ~12 min |
| Wall time per 1,000 updates | ~44 min |

### Result: overfitting after about 1,000–2,000 updates

| Update | Held-out score, EMA | Held-out score, raw | Speech-panel WER, EMA | WER, raw |
| ---: | ---: | ---: | ---: | ---: |
| 0 (initializer) | — | — | 1.2% | — |
| 1,000 | 0.3332 | **0.3305** | 1.7% | 2.4% |
| 2,000 | **0.3306** | 0.3394 | 1.7% | 4.6% |
| 3,000 | 0.3370 | 0.3582 | 2.9% | 3.5% |
| 4,000 | 0.3530 | 0.3873 | 4.3% | 5.7% |
| 5,000 | 0.3784 | 0.4217 | 5.6% | 7.5% |

Lower is better for both. Training loss kept falling (to about 0.12–0.15 at update 6,000) while held-out score and WER rose: classic overfitting. At batch 64, 1,000 updates is about 7.9 passes over 8,140 clips; by update 5,000 the model had seen each clip about 39 times. WER comes from an ASR approximation and is marked tentative by the runner. The run was stopped at update 6,000; **update 1,000 (raw weights)** was selected as the teacher. Student distillation from it is in preparation; no new student has been qualified yet.

Lessons:

- Fixed minimums (50 corpus passes, 8,000 updates) forced training far past the best checkpoint. Selection and stopping must follow held-out and speech evidence, never training loss or the final update.
- Keep a retrievable candidate at every evaluation; the best weights here came early.

### Training infrastructure notes

- Kaggle caps a session at 12 hours. The runner deadline counts from kernel start, staging included, and now stops 30 minutes early so the ~5 GB resumable state can be written and uploaded. The previous 5-minute reserve could lose up to 1,000 updates.
- Periodic 10-minute local checkpoints were removed: a crashed worker ends the session as failed, which cannot be resumed from its output, so they only cost time. Checkpoints at each 1,000-update evaluation go to a private bucket with three rotating slots.
- A later session resumes from the previous session's saved output under the same experiment, bucket run ID and lifetime GPU budget, skipping latent preparation.
- Kaggle's public API cannot cancel a running session; cancellation is done in the web UI.
