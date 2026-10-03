# Shared local voices

The current local route is **base OmniVoice, 32 generation steps by default**,
with 16 steps available in Companion Manager → Settings → Local voice quality. Both settings
use **FP16 on CUDA through PyTorch**, without TensorRT or `torch.compile`.
The numbers 16 and 32 describe generation steps, not floating-point precision.

September 29: the worker now uses bounded CUDA graph replay around the original
FP16 forward. See [VOICE_ACCELERATION.md](VOICE_ACCELERATION.md) for comparable
timings, memory definitions, exact-WAV checks, fallback and the bridge-only
opt-out. FP8 remains an isolated candidate, not the installed voice precision.

## Routing and lifetime

- **Companion Manager → Settings → Companion voices** selects
  **OmniVoice (default)** or **Convai**. The manager uses the player's assigned
  CET shortcut. Apply saves the selection for future launches; valid saved
  choices take precedence over the new-user default.
- The current catalog has **75 prepared local voice profiles** out of 79.
  Convai generates their reply text, and one shared OmniVoice model produces
  speech from attributed game recordings. The four profiles without prepared
  references—8ug8ear, Jake Estevez, NC Resident Male and NC Resident Female—use
  their configured Convai voices. Choosing Convai uses online voices for all
  characters.
- While OmniVoice is selected, the bridge starts one hidden worker. Lazy
  conditioning prepares Johnny, Judy and Panam at startup, then prepares other
  profiles on invitation or when speech needs them. At most **eight conditioning
  prompts** are cached in memory; an evicted profile can be prepared again from
  its own reference. The shared model stays loaded without idle eviction.
  Changing steps updates the next reply without reloading weights.
- October 1: switching the MCM selector to OmniVoice now begins that preparation
  from the draft immediately, before Apply. Apply reuses the prepared worker;
  Revert or leaving unsaved Settings cancels preview-only residency. Current
  replies keep their original route. See [VOICE_PREPARATION.md](VOICE_PREPARATION.md).
- Selecting Convai waits for the current conversation reply (including every
  streamed phrase or microphone response) to finish. Subsequent replies use the
  character's configured Convai voice. The old worker finishes outstanding CUDA
  work and exits through EOF, releasing its GPU allocation. Status distinguishes
  a pending change, releasing memory, and a fully unloaded model.
- Switching back warms one new worker only after the old worker exits. Rapid
  toggles cannot overlap workers. Native audio already prepared can finish
  playing while the model is released. None of these changes restart the game.
- Only one GPU render runs at once. Cancelling a turn discards its audio, but
  retains ownership of the worker until that render finishes. Queued cancelled
  work is skipped. Shutdown uses pipe EOF. Startup and a phrase render have
  180-second and 120-second deadlines. After completion or timeout, shutdown
  allows 10 seconds for exit, then terminates only the owned child and waits
  5 seconds for confirmed exit. An unconfirmed exit blocks replacement workers.
- WAV output has no added EQ, pitch/speed change, loudness normalization or
  denoising. It enters the existing native positional emitter and subtitles.
  Convai audio timings are discarded for local speech. Local phonetic lip sync
  and phrase playback now follow the native audio cursor; see
  [SPEECH_STREAMING.md](SPEECH_STREAMING.md) and
  [LIPSYNC_REFINEMENT.md](LIPSYNC_REFINEMENT.md) for the current validation limits.
- Model errors preserve the written reply, without borrowing another voice.
  The provider choice is explicit, not automatic failover or a second request
  that silently rewrites the answer. Switching to Convai and back can recreate
  a failed local worker; restarting the conversation bridge also recovers it.

## Local setup and operation

### Full-cast reference activation — October 1

The wider-cast configuration replaces the original Johnny/Judy/Panam-only
scope. It includes those three unchanged accepted descriptors plus 72 additional
source-qualified descriptors. Preparation checks actor attribution, reference
bytes, transcript and identity; the user authorized activation without another
listening-approval gate. This does not claim every generated voice matches the
original performance. See [VOICE_SOURCE_ACTIVATION.md](VOICE_SOURCE_ACTIVATION.md)
for the activation contract and [COMPANION_UPDATE_2026-10-01.md](COMPANION_UPDATE_2026-10-01.md)
for the installed catalog checkpoint.

Characters share the same pretrained weights. A profile adds a recording,
transcript and cached conditioning prompt, rather than a separate fine-tuned
model. The version 2 registry uses lazy preparation, three startup profiles and
an eight-prompt memory cache. Invite prepares the selected profile before spawn
permission. A missing or unprepared reference uses Convai explicitly.

The shared pinned model/tokenizer snapshot is 3,267,470,260 bytes (3.04 GiB).
The earlier three-reference setup measured 3,226,982 bytes of selected clips
(3.08 MiB), with a ready 32-step worker reporting 1,969.81 MiB allocated and
2,046 MiB reserved on CUDA with float16 parameters. Those reference and GPU
figures describe that earlier run, not storage or memory for the entire current
cast. Python/CUDA/browser dependencies add disk costs; no final ZIP size has
been measured.

The ignored `runtime/local-voices.json` is generated by
`scripts/Prepare-LocalVoices.py`. It verifies existing reference hashes and
selects the pinned base model; it does not download, extract or train anything.
The rejected Judy fine-tune is not used.

The worker imports the actual OmniVoice adapter from
`vendor/reference-voicestudio` (revision
`08a1592e3cb9b4c36beef5fa3185ec2313bb1fea`). Base weights are
`k2-fsa/OmniVoice` revision `c5fdb5ccb189668d56333f77ba2629f4cd7535f4`.
The voice service needs the prepared CUDA Python environment and those local
assets. This development setup is not yet a distributable installer.

Use `scripts/Start-ConversationBridge.ps1` and
`scripts/Stop-ConversationBridge.ps1` to own its lifetime. The stop script
requests graceful shutdown of the identified bridge. The worker normally drains
CUDA work through EOF; the bounded owned-child fallback above handles hangs. The game runtime's `local-voice-state.json` records actual device,
parameter dtype, engine, steps, worker PID and residency. `settings.json`
persists `omniSteps` and the bridge polls changes without a game restart.
It also persists `voiceProvider` (`hybrid` or `convai`). Partial/invalid writes
do not reset an already valid choice. The affected realtime connections renew
their TTS configuration while preserving committed character session IDs.

## Historical provider selection checks — September 29

This checkpoint predates full-cast activation and the current shorter UI labels.
Function keys below describe the user's bindings during that test.

- 36 focused checks passed; the installed-MCM environment check then passed in a
  separate run against the actual installed API (37 applicable checks passed).
  Coverage includes saved Convai startup without a model, busy-turn deferral,
  fixed phrase quality, rapid switches, switching during warmup, stale connection
  completion, settings persistence and rollback when a save fails.
- Installed the Lua settings update and restarted only the hidden bridge. The
  user reloaded CET, selected **Convai for all characters**, applied it, and
  confirmed Judy's F6 reply had voice and subtitles. The native playback receipt
  records the realtime Convai route and a 2.005-second audio track.
- The previously warm FP16 worker exited normally. The bridge reported
  `remote`, `resident: false` and zero CUDA allocation/reservation. The saved
  Convai selection was active at that checkpoint; no game restart was needed.
- Switching back and rapid changes are covered by worker-lifecycle tests. Their
  corresponding in-game selection/playback checks have not been repeated.

## Historical verification — September 28

All 65 automated bridge/Lua checks passed. The full native script set compiled
with normal installed dependencies at 16:01 IST, compiler exit 0.

`scripts/Test-ResidentVoices.mjs` exercised the real shared worker: all three
references warmed, three 32-step WAVs and one Johnny 16-step WAV were returned,
and the worker exited normally. Actual reported precision was `torch.float16`
on `cuda:0`, with 1,945 MiB allocated and 2,386 MiB reserved after warming all
three references (**1.90 / 2.33 GiB**). One startup including all three warmups
took 39.26 seconds. Those four short renders took 4.76, 3.68, 3.56 and 1.79
seconds respectively; these are integration checks under changed game settings,
not additions to the fixed-view RT Ultra/60 FPS benchmark. GPU reservation may
grow for longer dialogue.

The earlier single-Johnny RT60 benchmark reserved 2,208 MiB (**2.16 GiB**) for
both qualities and sampled about 3.35 GiB process RAM. All companion copies
share the model; memory is not multiplied by their count.

At this September 28 checkpoint, live hybrid conversation playback, mixed
local/Convai F8 ordering, and manager acceptance were still pending. Subsequent
user checks accepted MCM and Judy's local speech; the September 29 provider
selection check above records the new Convai-only path separately.
The real-worker report and WAVs are under ignored `runtime/local-voice-check/`.

## Experimental Pocket TTS adaptation

Pocket TTS is being evaluated as a shared CPU voice model. The current in-game
provider choices are OmniVoice and Convai; Pocket outputs are research artifacts.
Each character conditions one shared model with an original voice reference.

`scripts/Prepare-PocketCastCorpus.py` builds a private corpus from installed
dialogue, exact subtitles and authenticated scene/speaker joins. It preserves
original WAV bytes and separates connected scenes, previous evaluation material
and reference recordings. Sparse or unavailable speakers are recorded explicitly;
translated English subtitles are not paired with Japanese speech for training.

`scripts/Pocket-KaggleTrain.py --spec <local-spec.json> --mode all --plan-only`
checks staged inputs before GPU work. Removing `--plan-only` runs word alignment,
frozen-codec preparation, 24-layer teacher adaptation, six-layer depth distillation
and selected-checkpoint evaluation. The runner uses the pinned official source
revision `41cbc84af539ea78a804ffca5f9c6edc1a22ce44` and local model assets.

Training preserves the released latent calibration and pools variable-length
losses across the effective batch of 64. The GPU precision probe exercises the
full JVP loss against FP32 before choosing mixed precision. Checkpoints retain
optimizer, EMA, scaler and per-rank RNG for bounded-session continuation. Fixed
development data selects checkpoints; final test data and listening samples
evaluate the result. Epoch and validation bounds adapt the official presets to
the smaller cast corpus. No quality-parity claim follows from a lower loss.

After downloading the selected teacher and student exports, run
`python scripts/Pocket-CompareExports.py --teacher-export <teacher/export> --student-export <distill/export> --output <new-directory> --public-student-stream --plan-only`.
This verifies the official source digest, matching training identities, selected
EMA receipts and model hashes without importing a model. Remove `--plan-only`
to produce the CPU comparison; use the prepared research Python environment.
Execution rebases each downloaded export's YAML to its local assets through
`relocate_export`; it does not alter its weights.

The default comparison preserves the cloud sampler settings: teacher CFG2,
student CFG1, one decode step, temperature 0.3, seed 1337 and the same 22-second
Johnny reference. The optional public student stream runs separately because
the public inference API has no CFG2 control. It additionally measures first
PCM arrival and the observed buffering needed to avoid underruns.

Each model runs in a fresh CPU process, with two threads, one warm repeat,
a 30-second output cap and a 900-second worker deadline by default. Load,
reference preparation, first/warm generation, resident RAM and file sizes are
stored in `comparison.json`; `listen/` contains the generated WAVs alongside
unchanged original and OmniVoice 32 references. Cold means a fresh worker with
local assets and the OS disk cache retained. These results do not measure game
FPS or establish voice quality. The helper hides CUDA, stays offline and never
reads account credentials or changes the installed voice provider.

The completed October 2 run selected teacher EMA at step 1,200 and student EMA
at step 8,572. The student EMA failed the actual speech check: three of four
cloud examples reached the 30-second cap, and CPU EOS logits never crossed the
normal threshold. The final raw student checkpoint ended both Johnny probes
naturally with identical detector/normalization tensors and unchanged inference
settings. Its separate export is explicitly labelled raw. The 0.9999 averaging
schedule retained about 42% of the initial shortened model after this bounded
run; a lower numerical loss did not qualify the averaged audio.

`Pocket-CompareExports.py --student-weight-kind raw` accepts that separately
provenanced student candidate after two validated termination probes. It does
not substitute raw weights silently or change the teacher selection. The raw
student is fast, but automated transcripts suggest missing or slurred words;
keep it experimental until listening confirms quality. The production mod's
voice choices remain unchanged.

The user subsequently accepted the adapted teacher and rejected the small raw
student's quality. The corrected student experiment starts from the mature
released September six-layer backbone (`student_init_from`), preserving the
accepted teacher's flow/EOS heads and bit-identical latent calibration. It does
not repeat teacher adaptation. `--mode student` requires an imported selected
teacher whose checkpoint, EMA export, hashes and parent identity agree.

Execution and learning schedule are separate: `distill_max_steps` bounds work,
while `distill_schedule_steps` sets the official optimizer's horizon. The current
experiment uses 6,000 updates, a 200,000-step horizon, learning rate `1e-4`,
1,000-step warm-up and EMA `0.999`. Initializer bytes and imported teacher assets
are hashed into the new run identity; resume rejects changed optimization.

Scheduled free-generation checks compare raw and EMA speech at 500, 1,000,
2,000, 4,000 and 6,000 updates, with an initial diagnostic at zero. Unprocessed
Johnny/Judy/Panam WAVs and tentative local ASR detect omitted words, early stops
and missing EOS. Speech candidates are retained separately from the best
teacher-forced MSE checkpoint, and exports record which weights actually won.
These automated checks do not establish voice likeness; listening is required.

The intended runtime target is the six-layer student. The teacher is retained
for frozen training targets and listening references. Pass `--student-only`
to the CPU comparison to load only the student, and optionally `--teacher-audio`
with an existing accepted recording; no teacher model is required at runtime.

### Teacher improvement candidates

The user accepted the corrected six-layer EMA student at update 6,000. That
export remains unchanged. The subsequent student-refinement notebook was
cancelled at the user's request; current work improves the teacher as a training
target and listening reference.

The original teacher stopped at update 2,000 after development plateaued;
accepted EMA was update 1,200. Training loss kept falling while its fixed
development objective worsened. Repeating the last checkpoint with the same
recipe is not evidence of better voice likeness. The proposed improvement
warm-starts the accepted EMA with a **fresh optimizer**, half learning rate
(`1e-5`, constant), 250-step warm-up, EMA `0.999`, effective batch 64 and a
2,000-update cap. Upstream source, LSD sampler, Mimi, tokenizer and frozen
latent calibration remain pinned. Training alone does not approve a candidate.
The user's fixed-weight listening choice is the **current adapted April teacher
at update 1,200 with two LSD decoder steps**, CFG2 and temperature 0.3. That
setting is used for this new run's step-zero baseline and all quality probes;
its old one-step speech metrics are not substituted. September remains a
separately prepared comparison, not this run's initializer. A released model's
unknown training update is never relabelled as this project's update 1,200.
The new starting model's step-zero learning baseline is distinct from the
accepted 1,200-update comparison. That old control is overlaid only once at
step zero for regression/speech measurements. Weights, buffers, modes, gradient
flags and RNG are restored in `finally`; fresh FlowLM streaming/conditioning
states are created for each utterance. Codec and calibration equality are required.
This selected run initializes and compares the same accepted weights, so it
does not perform an unnecessary second overlay/model evaluation.

Corpus changes are separately versioned and verified. The raw WAVs have roughly
300 ms zero edges, but all 2,743 original aligned training examples use interior
word-gap cuts. Leading zeros were conditioning-only and observed tails were
already excluded. The raw edge duration is not proof of supervised silence or
a latency defect. The reviewed baseline therefore keeps **native raw WAVs** and
upstream interior word-gap windows, including the last-word-plus-0.2-second
target tail. Its bundle states `derivativePolicy: native_raw_upstream_word_cuts`.
Zero-only 0/40/80 ms guard variants remain separate codec experiments. They are
not adopted as blanket training edits or described as an audible minimum.
Original WAVs, reference recordings and historical tests stay unchanged; no
denoise, gain, pitch, or output-audio trimming is used.
Every new training row must requalify an interior word gap at least one second
from the window start with the upstream **raw-duration** reserve of one second.
The later last-word-plus-0.2-second crop can leave a shorter actual target;
qualification records that duration and floor-frame last-word coverage honestly.
Short authentic utterances without such a gap remain full-speech listening
probes or reference candidates. They do not enter objective validation through
the loader's overlapping fallback.

`teacher_quality_policy: macro_speaker_cfg2_old_dev_v1` uses three declared
development panels:

- **Tier A:** never-trained utterances from unused training scenes. Every voice
  contributes equally to the primary macro objective.
- **Tier B:** never-trained utterances within previously seen scenes. It has its
  own macro regression score and explicitly does not demonstrate scene-independent
  generalization. Recording, WEM, PCM, transcript and history exclusions still apply.
- **Original development:** the same 94 clips and their original ID order. It is
  a separate regression panel against the accepted anchor's new-run step zero.

Only the documented available speakers are declared; missing independent
coverage is reported. No old training clip becomes an unseen validation clip.
The new manifests, corpus receipt, actor allowlists and anchor export are hashed
into the new run identity. Cheap metadata gates run before model allocation.
The staged receipt also verifies actual manifest/audio/ledger bytes. Its semantic
history, original-development content, wording and floor-frame admission proof
is checked by the hashed teacher-only `teacher_data.py` module against actual
raw recognizer files and launches, original native receipts, and independently
frozen protected content. Forced word
alignment alone is not independent transcript agreement. Unreviewed integrity
counters are not a launch qualification. The original 2,743 training recordings
receive a separate wording audit before the improved-teacher job is assembled.
Only admitted train/Tier A/Tier B wording must be qualified. Wording uncertainty
in the original 94 development and 76 test clips stays in a separate diagnostic
sidecar bound to their source identities; original
captions, scene/delivery metadata, word spans and order stay unchanged.

Precompute records actual decoded float32 PCM/sample counts, accepted Mimi encode
weights, encoded/stored tensor frames and file hashes. Teacher cache hits decode
the source again and inspect the real finite FP32 tensors. Preparation binds the
ordered manifests, annotation paths and stitch calibration to an output receipt;
the teacher verifies it before updates. Input corpus receipts are never rewritten
to claim observations from a future cache. Existing student pipelines retain their
original preparation behavior.

Teacher speech checks are scheduled with CFG2 and the declared decode-step setting at new-run updates
0/500/1,000/1,500/2,000. Johnny, Judy and Panam each have their own original
quote plus five common probe sentences. Raw and EMA WAVs and exact weight-state
receipts are retained separately. Student speech remains CFG1 with its original
frozen-head checks. The pinned LSD sampler now receives actual one/two/four-step
settings, with the executed count in WAV receipts and nondefault counts in the
run/probe identity. Default one-step student behavior remains unchanged. Sampling
screens are comparisons of fixed weights, not evidence of additional training.
Receipts distinguish scheduled, reached and completed checkpoints. Early
plateau, owner stop or a deadline can leave later checks unreached; the reason
is reported rather than claiming every scheduled probe executed.

An EMA candidate needs primary macro improvement, at most 3% regression in both
monitor panels, and complete, finite, naturally terminated speech with no increase
in tentative ASR omissions versus the anchor. ASR, development loss and low-energy
edge timings do not establish voice likeness or naturalness. The bounded
`quality-best.pt` candidate needs listening; it never falls back to a latent-only
best, automatically replaces the current student, or becomes a production teacher
provider. Whole teacher weights are not duplicated at every audio probe.
If no eligible candidate is produced, completed evaluation explicitly reports
`candidate_available: false` and `no_eligible_teacher_candidate`.

`--mode teacher-only` prepares, trains and evaluates the teacher without starting
student training. A hard 3.5-hour session bound and a conservative 7.25 GPU-hour
preflight allowance protect the private job. A genuinely better teacher can later
be used for a separately authorized distillation from the accepted student.

The October 3 teacher-only pilot completed its real 1,744-row cache gate and
trained on two T4 GPUs. It stopped at update 1,250 on a development plateau,
selecting the speech-tested EMA at update 500. Its unseen-scene, original
94-clip and conditional objectives were 0.674%, 0.514% and 0.477% lower than
the accepted two-step anchor. All 18 selected-candidate probes completed;
these loss checks do not establish perceptual improvement. The accepted
student and production voice providers remain unchanged. Matched Johnny,
Judy and Panam listening pairs retain CFG2, two decoder steps, temperature
0.3, seed 1337 and the same native references/texts. No audio processing is
applied. The training sampler returns whole utterances, so those cloud
generation timings are not streaming first-PCM latency.

The user approved the new teacher for the next student distillation. The
opt-in `qualified_macro_student_transfer_v1` policy starts from the accepted
6,000-update student backbone and copies the new teacher's sampler/EOS heads,
which stay frozen. It imports the teacher's flattened selected-EMA checkpoint
with exact source/tensor checks. The same qualified corpus, protected panels
and actual cache checks apply before student updates.

The transfer pilot uses a fresh optimizer, LR 5e-5, 250-update warm-up, EMA
0.999 and at most 2,000 new updates. Selection uses speaker-macro student MSE,
the original/conditional regression panels and complete speech probes. The
original accepted student is a separate control; update zero already has the
new teacher heads and is labeled as a hybrid. Teacher comparisons use CFG2
and two decoder steps; student comparisons use CFG1 and one step. Export
checks verify the actual frozen heads, calibration and codec tensors. All
probe audio is retained, while weight retention is bounded to selected,
MSE-best and last checkpoints. A candidate still needs listening and measured
streaming startup before becoming a production voice model.

The October 3 transfer pilot completed all 2,000 updates and selected EMA update
1,500. The actual 1,744-row cache gate passed. Compared with hybrid update zero,
speaker-macro unseen-scene MSE fell from 0.0703013 to 0.0536907 (23.63%); the
conditional seen-scene panel fell from 0.0742409 to 0.0519776 (29.99%). The
original 94-clip panel remained within its regression bound. On the separate
76-clip final test panel, accepted/new student MSE was 0.0405275 / 0.0401581.
These are imitation-objective measurements, not a listening-quality score or
a direct comparison with the teacher's different training objective.

All 18 selected speech probes were finite and naturally terminated, with no
tentative ASR deletions. Serialized checks verified the actual copied frozen
heads, latent calibration and codec. The downloaded six-layer FP32 export is
438,033,312 bytes (about 418 MiB), SHA256
`373a0df2115b1e5dc1c583bb0033838ba4ae337499831261e3938218d239a391`.
Its input identity is
`a881e3024512339c5c601219f4e453370a6769a2e59e6f8750cdc37c110fc152`.
The previous accepted student remains preserved. Listening qualification and
the paired CPU streaming measurement are still separate gates; production
OmniVoice/Convai selection remains unchanged while Pocket TTS is integrated.

The subsequent paired CPU test ran with Cyberpunk present and the user standing
still in normal gameplay. On the i9-13980HX, FP32 with two CPU threads, five warm
calls per model produced first copied PCM in 160.08 ms for the old student and
140.62 ms for the selected student. Full generation of the 7.28-second quote
averaged 4.121 / 3.803 seconds. The new process-cold launch, imports, model load,
reference preparation and first PCM totaled 29.381 seconds; disk caches were
not flushed. Peak process RSS was about 1.69 GiB and GPU allocation was zero.

Both raw waves have roughly 0.686 seconds of low-energy prefix. Estimated speech
onset for an ideal uninterrupted sample player was 0.846 / 0.826 seconds; this
is not a recorded audio-device or full Convai/game reply latency. The twelve
streams completed naturally, source assets stayed unchanged, and both owned
workers exited. Windows reported Balanced; the laptop's separate OEM profile
was not inferred. Raw recordings and verification live under ignored
`runtime/student-transfer-stream-20261003-verified/`.

After hearing Johnny, Judy and Panam, the user approved this student and requested
that Pocket TTS replace OmniVoice, with Convai retained as the alternate. The
separate adoption receipt is `runtime/student-selected-improvement-20261003.json`;
it does not rewrite the frozen experimental selection/export receipts. Runtime
integration is in progress; the approved weights and earlier fallbacks remain
preserved. The local model should warm at voice selection and reuse one CPU
instance across character reference states.

A separate CPU experiment kept the accepted teacher's CFG2 and original
reference. Supported dynamic INT8 reduced full generation from 15.82 to
10.02 seconds on two CPU threads, with resident RAM falling from 2.11 to
1.75 GiB. Loading still peaked near 3.20 GiB because it first loads FP32.
The source teacher is unchanged; perceptual INT8 parity remains unconfirmed.
