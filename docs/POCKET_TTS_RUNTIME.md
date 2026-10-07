# Pocket TTS runtime

## October 5 update-5,000 student and rollback

The Pocket TTS choice now uses **student update 5,000, raw weights** (the user's
pick after listening) instead of the update-1,500 EMA student. It is the same
six-layer export layout: CFG 1, one decode step, temperature 0.3, four CPU
threads, `frames_after_eos=1`, the same `inference.yaml` and `tokenizer.json`
(hashes unchanged). The export is `runtime/pocket-student-full-a-s5000-raw/`
(`model.safetensors` sha256 `43dfe333...02e3`, 438,033,312 bytes). It was built
by `scripts/Rank-StudentCheckpoints.py` (the update-5,000 raw `flow_lm` tensors
over the previous student's Mimi tensors) and its source file lives at
`E:\CyberpunkConvai-offload\work\student-ranking\exports\s5000-raw`. That
export carried no `receipt.json`, so one was written beside it recording the
provenance (`weights: "raw"`, step 5,000, the run's input identity; the local
slot-2 checkpoint no longer exists, so its own file hash is not recorded). The
runtime validator now accepts `weights` of `ema` or `raw` in a receipt; the
step, CFG, source revision, input identity and model hash checks are unchanged.
Reference states are built in the worker at run time, so no per-voice
preparation is stored; `scripts/Prepare-PocketVoices.py` only restages the
configuration.

`runtime/pocket-voices.json` changed in `runtime.exportDirectory`, `model.sha256`,
`model.receiptSha256`, `model.selectedStep` (1500 to 5000) and
`model.inputIdentity`; `configSha256`, `tokenizerSha256`, threads (4), sampling
and the 79 voice entries are the same (a few transcripts that held a damaged
character in the old file now carry the original punctuation; Pocket ignores
transcripts). Restage command:

```powershell
vendor\pocket-tts-env\Scripts\python.exe -B scripts\Prepare-PocketVoices.py `
  --export runtime\pocket-student-full-a-s5000-raw --source vendor\pocket-tts-training\source `
  --python vendor\pocket-tts-env\Scripts\python.exe --references runtime\pocket-voice-references.json `
  --reference-directory runtime\voice-references --work runtime\pocket-voice-work `
  --output runtime\pocket-voices.json --threads 4 `
  --model-sha256 43dfe333cbdc633f4b344649f6505da65f092c911f6723249f242993d47d02e3 `
  --input-identity 03e89124733a88ac5d869f0df5c79f0d2d60cc88a77a67bbc32d444a59ffc22c
```

**Rollback to the update-1,500 student.** The old export stays in place at
`runtime/kaggle-pocket-student-transfer-ddb133ba-output/student-transfer-results/distill/export`,
and the previous configuration is saved as
`runtime/pocket-voices.student-step1500-ema.json`. To switch back, copy that
file over `runtime/pocket-voices.json` and restart the bridge (the running
worker keeps its loaded model until restart). Its hashes (sha256 `373a0df2...`,
step 1500) are inside it. Staging a fresh config with the command above, but with
the old export directory, model hash `373a0df2115b1e5dc1c583bb0033838ba4ae337499831261e3938218d239a391`
and input identity `a881e3024512339c5c601219f4e453370a6769a2e59e6f8750cdc37c110fc152`,
produces the same result.

Smoke test (separate process, its own work directory, four threads, native
Windows, with the game bridge's own worker also running): two voices, two lines
each, streamed 80 ms PCM chunks; first PCM 154-209 ms; real-time factor
0.56-0.68 (generation time over audio time; below 1 is faster than real time);
no worker warnings. Johnny's first prompt preparation took 2.4 s cold, Judy's
0.8 s.

## October 4 inference parity and replacement boundary

The live public stream now explicitly uses `frames_after_eos=1`, matching the
student comparison audio. Previously it omitted that argument, allowing the
pinned upstream implementation to guess a longer text-dependent post-EOS tail.
CPU float32, temperature 0.3, one decode step, CFG1 export selection and four
threads (the current default) remain the accepted inference settings. This correction changes the
generator's tail policy, not the original PCM or character reference recording.

The expanded A teacher/student training is described in [voice training](VOICE_TRAINING.md).
The accepted update1500 student remains configured until a new export is
qualified. Model replacement requires a new immutable export and all four asset
hashes in a staged configuration, followed by a clean bridge/worker restart.
Reference states live only in the worker's memory and belong to its loaded
model; editing a JSON path does not replace an already-running worker or cache.
The shared phonetic facial path consumes PCM/timing and has no old-model filename
dependency. Native voice/face acceptance of new weights remains separate.

## October 3 live corrections

The first game check played Pocket voice but applied zero facial frames: Lua's
continuous updater still admitted only the Convai facial source. It now admits
qualified envelope and coarticulated-v5 local phonetic prefixes with the same
actor, request, generation, duration, track and ordering checks. An actual
PocketFacialStream → Lua updater regression failed before this change; the
54 focused facial/delivery checks pass after it.

The same check exposed a renderer drain race: playback closed while the host
awaited state publication, then a late control reached the closed player. The
local client now recognizes verified natural drain and the host publishes its
fresh ended clock. Fake and real muted Edge regressions reproduced the exact
error before correction; 54 renderer checks pass. Visual game acceptance is
still required. Pocket is the source default and the current saved selection.

## Selected model and references

The approved local voice backend is the English six-layer student, with CFG 1
and one sampler step. Since October 5 that is update 5,000 raw (see above); the
update-1,500 EMA student was the choice until then and is kept for rollback. Its shared float32 weights are
438,033,312 bytes. The 24-layer teacher stays in the training/comparison workflow.
Runtime code does not search for teacher weights or choose another export.

`scripts/Prepare-PocketVoices.py` creates the ignored `runtime/pocket-voices.json`
from an explicit approved model SHA, training identity, pinned source, Python
executable, source-qualified reference registry and separate work directory. It
hashes all four export assets and verifies the EMA receipt, six-layer CPU config
and local source before writing the configuration. It loads no neural model.
There is no implicit development-path or download fallback.

For this development setup, the explicit reference input is
`runtime/pocket-voice-references.json`. It preserves the approved Johnny22
descriptor plus the existing qualified cast descriptors. Reusing the older
Omni registry would select its different short Johnny recording. The generated
config records the reference-registry hash; runtime ready receipts attest the
actual per-character WAV hashes separately.

The worker verifies those same identities before importing/loading the model.
It writes a relocated YAML copy only inside its owned temporary work directory;
the downloaded weights, tokenizer, inference YAML and receipt are never edited.
The pinned upstream revision is `41cbc84af539ea78a804ffca5f9c6edc1a22ce44`.

Johnny's runtime-owned reference is a byte-for-byte copy of the approved
22.286-second original dialogue montage. Judy and Panam use the approved
original reference bytes, and the wider cast retains attributed game recordings.
Pocket conditions on **audio only**. Legacy registry transcript text is retained
as metadata and is not fed to the model. Missing, changed or unprepared
references withdraw that exact character's local route; no speaker alias is used.

## Model lifetime

`VoiceSelection` falls back in the order OmniVoice, Pocket TTS, Convai
(see [local voices](LOCAL_VOICES.md); the Settings menu lists Pocket first and it is the default). It stores
`voiceProvider=pocket|omni|convai` plus `omniSteps=16|32`. Legacy `hybrid`
selections migrate to `omni` with their saved quality; saved Pocket and Convai
choices remain selected, and unknown values take the default (Pocket).

An unsaved local choice queues preparation immediately. Backend replacement
waits for the current owned reply and confirmed worker exit; only one local
backend is resident. Saving the selection reuses preparation, while discarding
changes or leaving without saving restores the saved backend. Omni's 16/32
choices share one GPU model and reference cache. Pocket keeps its separate CPU
model, configuration and reference registry. Selecting Convai releases local
residency after the choice is saved.

One hidden worker owns the CPU model and an eight-state LRU. Invite encodes the
selected acoustic reference before spawn permission, alongside the existing
memory and connection preparation. The worker revalidates reference bytes even
on a cache hit and uses `copy_state=True` for every utterance. It never mutates a
cached speaker state by continuing a previous generated conversation.

CPU threads are explicitly limited to two by default (configurable from one to
four by the operator), with one interop thread. CUDA is hidden, offline asset
loading is enforced and cloud tokens are removed from the worker environment.
The ready receipt confirms the selected export/config/tokenizer/receipt hashes,
source, reference identities, CPU float32 parameters and thread settings.

## Incremental audio and facial timing

`PocketVoice.synthesizeStream(profile, text, {signal, onPcm})` passes the complete
reply to the public Pocket streaming generator once. It emits copied little
endian float32 PCM at 24 kHz mono, with contiguous sample offsets and separate
generator-yield, copied-ready and host-received timings. Those timings are not
audio-device latency measurements.

Each packet waits for its consumer acknowledgement. `RealtimeHost.playLocalPcm`
owns one dedicated page in the existing hidden browser, separate from Convai's
session/page pool. Its renderer performs only the established PCM16 device
conversion. It uses one AudioContext/worklet and one sample clock for the whole
utterance; packet boundaries are not sound boundaries. Native game admission
must authorize the exact actor before playback starts. Source EOF and audible
device drain are separate states.

`PocketFacialStream` analyses copied float PCM windows with the existing Rhubarb
phonetic mapper. A growing audio-envelope pose is available immediately while
phonetic work runs beside playback. There is no full-file lip-analysis gate.
Analysis jobs and PCM storage are bounded, and late/cancelled work cannot revive
an old actor. Native face snapshots are clipped to **acknowledged received
samples**, not generated-ahead samples, then animated against the audible
consumed-sample clock. Only actual final EOF eases the mouth back to neutral.
Convai continues using its original provider facial data and continuous audio.

## Cancellation and ownership

The worker's reader can signal cancellation while generation is in progress.
Cancelling releases the caller immediately; the serial inference lane waits for
the native decoder to drain to EOF before a second utterance reuses Mimi. Merely
closing the upstream generator at a yield would skip its decoder join, so the
worker deliberately sets its stop event and drains before closing. A synthesis
exception is terminal: upstream prefill can throw after starting an unjoined
decoder, so that process is retired instead of reused. Reference preparation
failures before synthesis remain recoverable for the other valid profiles.

IPC carries a fresh owner token and request ID. Packets also retain exact
profile/model identity and sample offset. Startup, reference preparation,
generation, PCM acknowledgements and teardown have deadlines. Only the spawned
process handle is eligible for forced termination. A self-exit watchdog also
handles the actual interpreter behind Windows' venv redirector if EOF arrives
during a stuck import/load. Failure to confirm exit blocks replacement workers.

## Evidence and pending checks

The approved WSL CPU benchmark and listening samples are retained in the local
research artifacts. New fixture tests exercise the actual IPC/stream producer,
selected-asset rejection, cancellation drain, reference caching, draft/Invite
routing, native lip ownership and sample-prefix boundaries without loading a
neural model. A muted real Edge test verifies prefix playback before source
completion and exact drain with no Convai requests.

Two bounded native Windows attempts initially stopped before model loading.
Controlled imports isolated a stall when a command thread blocked on stdin before
NumPy initialized. Delaying the reader passed; a direct blocking Win32 read still
failed. The adopted fix polls `PeekNamedPipe` and reads at most currently available
bytes, retaining startup EOF/cancellation without that blocking call. The exact
native-lock mechanism is not asserted.

The corrected actual Windows student worker passed a 92-chunk, 7.44-second
incremental reply, cancellation after two packets, reuse of the same cached
reference/model process and confirmed shutdown. Its single diagnostic call
produced copied PCM at 270.64 ms and reached Node at 304.54 ms; these numbers are
not the controlled WSL benchmark or audible speech latency.

A combined real Windows student → muted Edge → Rhubarb check then passed prefix
playback before source completion, five phonetic windows, exact 7.36-second
device/facial drain, neutral final pose, zero underruns and one admission.
Workers/browser exited, no Convai page/session was created, and page requests
stayed on loopback. That supplied-text diagnostic includes browser setup and
analyser contention; it is not an end-to-end Convai benchmark or a claim of
rendered in-game facial quality.

Installation, in-game audible/visual acceptance and dependency packaging remain
separate gates. The prior failed runs and controlled import receipts are retained
as diagnostics, without changing immutable experimental model receipts.
