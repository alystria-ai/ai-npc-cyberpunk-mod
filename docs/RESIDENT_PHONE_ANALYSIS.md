# Resident phone analysis for Pocket speech

## Behavior and qualification

Pocket has a separate CPU acoustic analyser that follows its real incremental
24 kHz float PCM. It is prepared alongside Pocket voice selection and Invite;
reply onset never starts or waits for it. It recognizes acoustic phones and
uses the shared calibrated Cyberpunk jaw/lip trajectories. The renderer receives
the original samples independently. No audio normalization, silence removal,
resampling, effects, complete-file gate or new Convai request is added.

The actual production worker/client/Pocket delivery was replayed with ten
recorded production packet schedules across Johnny, Judy, Panam, Jackie and
Evelyn. Raw PCM hashes stayed exact, playback started before source completion,
and every utterance drained to its exact duration/neutral with zero underruns.
The truthful live format was present at the heard positions. Useful non-jaw
controls covered all sampled energy-present positions in these short English
captures, versus 0–21% with the earlier rolling batch analyser. This measures
timely control availability; it does not establish phoneme accuracy or natural
animation on every native rig. The in-game visual check remains pending.

The isolated decoder benchmark measured about 8.35 ms median, 9.25 ms p95 per
80 ms packet. Imports and decoder initialization took approximately 2.4 and
0.9 seconds and are paid during preparation. Actual figures vary with hardware
and load. RAM was not measured. Reused acoustic/phone assets occupy about
53.4 MiB on disk and allocate no model GPU memory.

## Ownership and timing

- One resident analyser belongs to the bridge. It stays available for an owned
  Pocket reply during a settings change. Provider retirement is reusable;
  permanent close is reserved for bridge shutdown. A replacement waits for
  confirmed physical EOF/exit, including rapid Pocket → Omni → Pocket choices.
- Every utterance has request, entity and generation ownership, strict command
  and PCM indexes, contiguous offsets, hash-checked packet copies and bounded
  pending work. Search, normalization and filter state reset for each utterance.
  EOF and a parent-process watchdog retire orphaned helpers.
- Live acoustic boundaries must match across two consecutive partial results
  outside the last 40 ms of input. Finalized boundaries can qualify once. Only
  their still-unheard suffix is admitted; current source/coverage follows the
  accepted renderer prefix and actual audible cursor. Unsupported, invalid,
  unavailable or late analysis uses the calibrated envelope fallback.
- Analysis alone uses a causal 61-tap 24k → 48k → 16k FIR with persistent filter
  state and rational phase. Its 0.625 ms delay is removed from acoustic timestamps.
  Packetization does not change that analysis waveform. Playback is separate.
- The new format is `pocketsphinx-allphone-live-v1`, engine
  `pocketsphinx-5.0.4-allphone-live`, on `original-audio-seconds`. It is never
  labeled as a Rhubarb batch result. The physical articulation table remains
  `coarticulated-v5`. Convai's ARKit data and Omni's phrase path stay separate.
- Expression receipts still follow the original owned Convai turn through the
  continuous speech document. Phone recognition supplies no invented emotion,
  asymmetry, evenly spaced text phonemes or alternating mouth sequence.

## Explicit development runtime contract

`runtime/phone-analysis.json` is an ignored prepared manifest, not a bundled
environment or downloaded model. It names absolute paths and exact hashes for:

- The Python executable and this project's `bridge/phone-analysis-worker.py`.
- PocketSphinx 5.0.4's native Windows extension and minimal Python package files,
  plus its distribution metadata/notices. These live in a separate dependency
  directory; preparation does not install into the TTS environment.
- The existing Rhubarb acoustic model and phone language model, including their
  source notices. No extra default PocketSphinx weights are shipped or loaded.
- The selected NumPy/SciPy versions required by the analysis-only FIR.

The wheel's Python config wrapper calls `find_spec('pocketsphinx.model')` even
when decoder paths are explicit. The minimal staged package therefore contains
a tiny hashed namespace sentinel at `pocketsphinx/model/__init__.py`. It contains
no default model weights. Omitting it makes native startup fail.

Prepare this contract with [Prepare-PhoneAnalysis.mjs](../scripts/Prepare-PhoneAnalysis.mjs),
passing fully qualified paths through `--python`, `--dependency-source`,
`--dependency-destination`, `--acoustic-model`, `--phone-model` and `--output`.
The source distribution must be the pinned 5.0.4 wheel. Preparation only copies
the minimal qualified files and writes a manifest; it does not execute a model.
Existing nonmatching staged files are rejected instead of overwritten.

Both the Node client and Python worker validate the selected identities before
readiness. Bad optional configuration or unavailable assets stop the analyser
while voice remains available with envelope animation. Failed preparation is
cached until retirement rather than retried on every polling tick. Cancellation
still propagates through Invite preparation. Diagnostics are written to
`phone-analysis-state.json`; no extra conversation or thinking popup is added.

Packaging remains separate work. A future runtime bundle must retain this
manifest contract, pinned Python/scientific/native dependencies, empty namespace
sentinel and acoustic notices, and materialize its actual absolute paths. These
development paths are not a qualified portable installer.

## Evidence and development method

The defect was reproduced at actual packet boundaries and heard positions
before adding a new analyser. Fixed-bin effort normalized over the accepted
utterance prefix removed packet-dependent jaw pumping. A real device-clock
replay then proved batch analysis arrived too late. The direct resident engine
was tested against the same preserved recordings and schedules, without neural
inference, GPU, provider conversations, game writes or service restarts.

Meaningful gates cover hashed assets and relocation, actual packet copies,
backlog bounds, malformed sources, stable future phones, truthful formats,
neutral completion, optional Invite warm/cancel behavior, busy provider changes,
confirmed exit, and the queued On → Off cancellation that previously stranded
the singleton. Independent lifecycle and packet/format reviews accompany the
production-path replay. Numerical/source gates do not replace native visual
acceptance.

Ignored evidence is in `runtime/verification/pocket-phone-integration-20261003`.
The earlier independent investigation/prototype remains in
`runtime/verification/pocket-lips-production-cadence-20261003`. Research uses
[Rhubarb's phonetic recognizer](https://github.com/DanielSWolf/rhubarb-lip-sync/blob/master/rhubarb/src/recognition/PhoneticRecognizer.cpp),
[its phone and shape rules](https://github.com/DanielSWolf/rhubarb-lip-sync/blob/master/rhubarb/src/animation/animationRules.cpp)
and the [PocketSphinx block/segment API](https://pocketsphinx.readthedocs.io/en/stable/pocketsphinx.html).
The bundled acoustic model is US English; multilingual precision is not proven.
