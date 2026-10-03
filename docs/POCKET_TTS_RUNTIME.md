# Pocket TTS runtime

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

The approved local voice backend is the English six-layer EMA student selected at update
1500, with CFG 1 and one sampler step. Its shared float32 weights are
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

`VoiceSelection` chooses Pocket or Convai at a conversation boundary. An unsaved
Pocket draft can start preparation while the saved choice remains Convai. Apply
reuses the worker; leaving or reverting a preview-only choice closes it. Saved
`hybrid`/Omni selections migrate to `pocket`; saved Convai stays Convai. Obsolete
generation-step values are removed from the manager settings.

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
