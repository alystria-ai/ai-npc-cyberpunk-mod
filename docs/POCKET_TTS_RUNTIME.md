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

## The end of every line and short lines (31 Oct 2026)

Both changes are in `bridge/pocket-voice-worker.py` (`stream_request`, `warm_up`) with their pure helpers in `bridge/pocket_voice_runtime.py`
(`plan_short_line`, `find_cut`, `fade_out`, `CarrierTrimmer`). Tests: `scripts/test_pocket_short_lines.py` and `scripts/test_pocket_voice_runtime.py`,
none of them loads the model. The `frames_after_eos=1` and "no fade, no trim" statements elsewhere in these docs describe the state before
this section.

**The end of every line.** The worker used to pass `frames_after_eos=1`. The end-of-speech mark comes a few frames before the sound has ended, so a
short line lost 50 to 320 ms of its last sound and ended 4 to 29 dB under the speech level (a click and a chopped word, worst on Barry Lewis,
whose clip starts late). The worker now passes `None`, which lets the pinned upstream choose (five frames for four words or fewer, three for
longer lines). The audio before the end is the same sample for sample. The extra frames decode to digital silence (peak under `SILENT_PEAK`,
0.001), and silence after the last sound is cut to `TAIL_SILENCE_FRAMES` (40 ms) with a 10 ms fade on the last piece when it was cut. Silence
inside the line (a pause) is held and sent in order when more speech follows. Nothing waits for the first sound.

**Short lines.** A line of one to five words came out grainy for V and the side characters, better when longer, and V improved after a while.
Two causes are addressed, neither can be proven without the model:

1. *Too little text to condition on.* A short line is said as the line, a full stop and a neutral carrier sentence
   (`SHORT_LINE_CARRIERS[None]`, English only: a language with no entry keeps the old path). Upstream merges sentences up to 50 tokens into one
   chunk, so line and carrier are one chunk of more than five words and take the path of a long line. The carrier is cut off the audio again by
   `CarrierTrimmer`: audio before 0.6 of the expected end of the line (letters at 65 ms each, at least 200 ms per word, 100 ms lead in) is sent
   at once, so the first sound is not later. After that the audio is held until the pause after the line is seen (80 ms or more under 6 percent of
   the loudest sound, and followed by sound), or until 1.8 times the expected end. The cut keeps up to 40 ms of the pause and a 12 ms raised
   cosine fade ends exactly at the cut, so there is no click. With no pause the cut is the quietest 10 ms of the window. The model is stopped as
   soon as the cut is chosen (it is not asked for the rest of the carrier), so a short line is not later to finish than before by more than the
   hold, and a line of six or more words takes the old path unchanged. `SHORT_LINE_CARRIER = False` in the worker turns this off for a listening
   comparison. In a simulated sweep (lines of 150 ms to 1.2 s, pauses of 100 to 320 ms, guesses of 0.6 to 1.6 times the truth) the cut always
   lay inside the pause. A guess more than about 1.7 times too long starts the window after the pause and leaves the first part of the carrier.
2. *A cold model.* The first generations of a fresh model run on cold code paths. `warm_up` says `WARM_UP_LINES` (a short line with its carrier and
   a normal sentence) once, silently, with a prepared voice, before the worker says `ready`, and the audio is thrown away. It needs a prepared
   voice: the startup profiles, else the first `prepare` command, and after a language swap the voices kept from the stash (a fresh language
   is warmed at its first `prepare`). A warm-up failure is logged (`Pocket warm-up skipped`) and never costs the voice. The log line
   `Pocket warm-up: N chunks in X ms` in the worker's stderr gives its cost.

The done frame of a short line carries `shortLine: {words, estimateFrames, cutFrames}` (the bridge ignores it) for tuning the constants from a log.

## Russian (31 Oct 2026)

The Pocket voice speaks Russian with an optional pack, `PocketTTS-Model-90M-Russian.zip` (folder `ru`, tag `ru`, about 440 MB). It is the sixth PocketTTS model
(`docs/POCKET_LANGUAGE_MODELS.md`) and follows the same rules: it is used only with the multilingual pack of the same language, and with the model but not the pack the
reply is written and the game says so once (notice `pocket-pack-ru`, "Russian replies show as text: the Russian multilingual pack is missing.").

**The model.** `genvoice/xVibePocketTTS` on Hugging Face (tag `v0.1.0`, commit `ac4f9f11eb4a110964c75a1e6f4104005455ac18`), GenVoice's Russian-only full fine-tune of
`kyutai/pocket-tts`, about 90M parameters. The repository has the weights (442 MB), a SentencePiece `tokenizer.model`, `config.yaml` (`tokenizer: sentencepiece`),
`RUNTIME.json` (`text_accent_format`: U+0301), three voice states (not used: the mod clones the voices from the dub) and `SHA256SUMS`. A check on the owner's PC loaded it with the
pinned `pocket_tts` (revision `41cbc84`) and the Runtime's Python through the same `TTSModel.load_model` call the worker uses, with no source change, cloned voices from the
Russian dub references (`multilingual/ru/picked/<character>.wav` and `multilingual/ru/v-voice/v-male.wav`) and ran at a real-time factor of about 0.5 on the CPU. The owner
listened and approved. The weights could not be fetched where this change was written, so every test below uses fake files.

**What differs from Kyutai's languages.**

| | French and the others | Russian |
|---|---|---|
| Tokenizer | `tokenizer.json` (Hugging Face tokenizers) | `tokenizer.model` (SentencePiece), the configuration says `tokenizer: sentencepiece` |
| Files in the pack | `model.safetensors`, `tokenizer.json`, `inference.yaml`, `NOTICE.txt`, `pocket-model.json` | the same with `tokenizer.model`, plus `stress-ru.bin` |
| Pack name | `PocketTTS-Model-100M-<Language>.zip` | `PocketTTS-Model-90M-Russian.zip` (`languagePrefixes` of `pocketModels` in `packaging/release.config.json`) |
| Credits in `NOTICE.txt` | Kyutai | Kyutai (base weights, CC-BY-4.0, with Kyutai's prohibited-use terms), GenVoice (the fine-tune, code MIT), and the stress data (below) |

**The tokenizer asset.** The worker's language assets were `model.safetensors`, `inference.yaml` and `tokenizer.json`. A model now names its tokenizer: the bridge sends
`expected.tokenizerName` (`tokenizer.model` for Russian, absent for the others, which means `tokenizer.json`) and the hash in `expected.tokenizerSha256`, and a language with
more files has their hashes in their own fields (`expected.stressSha256`). `inspect_language_export` checks every file against its hash before anything is dropped, as for every
language (`language_asset_fields`). `checked_config` takes exactly one of the two tokenizer files, refuses a `tokenizer.model` under a configuration that does not say `sentencepiece`
(the upstream loader reads a file ending in `.json` as JSON and anything else as SentencePiece, by the `tokenizer` field), and points `tokenizer_path` at the file in the pack.
The bridge lists the pack's files per language (`pocketModelFiles`, `POCKET_LANGUAGES.ru` in `bridge/pocket-language-models.mjs`), so a Russian manifest that lists `tokenizer.json`
or has no `stress-ru.bin` is not used. The builder (`packaging/build-pocket-models.mjs`) makes `inference.yaml` from the model's `config.yaml` with the weight and tokenizer paths
pointed at the pack files, and a missing `weights_path_without_voice_cloning` line is accepted for this model only (the worker sets it to `null` itself).

**Stress marks.** The model reads a stressed vowel as the vowel followed by U+0301. Written Russian has no marks, so before a Russian line is synthesized the worker does two
cheap passes over the line (`language_text` in `bridge/pocket_voice_runtime.py`, the work is in `bridge/russian_stress.py`):

1. a written `+` before a vowel becomes that vowel and U+0301 (`сл+ово`), `+ё` loses its plus and `ё` stays unmarked (it is always stressed), a `+` anywhere else (`2+2`) stays;
2. every word that has no mark, no `ё` and more than one vowel is looked up in a table of plain word to stressed letter and gets its mark. A word that is not in the table, a name,
   a word the data stresses two ways (`города`, `дела`, `замок`), a word with Latin letters or digits stuck to it and a word that already has a mark go through as written.

The table is `stress-ru.bin` in the pack. It is read when the Russian model becomes resident (after the model loaded, never at start, never for a player who does not speak Russian) and
dropped with the model when another language or English replaces it (`lang["stress"]` in the worker). A table that cannot be read leaves the voice running with the `+` marks only. A
lookup is a binary search in one `bytes` object, not a Python dictionary: measured here, loading takes about 40 ms and about 6 MB, and a line of fifteen words costs about 0.4 ms, far
under the first audio of a reply (80 to 200 ms), so the pass is not on the path of the frames the game draws. The pass runs before the short-line plan, in the worker, so the text the
model is given is the marked one.

**Where the table comes from.** The openrussian.org dictionary data, published on GitHub as `Badestrand/russian-dictionary` (commit `50e210c4803237779cb562bc1abcea529066031c`), licence
**CC-BY-SA-4.0** (the repository says so in its README and `LICENSE`), which allows redistribution and adaptation with attribution and the same licence for the adaptation. Four tab separated files hold
every word form with a `'` after the stressed vowel. `packaging/build-russian-stress.py` downloads them at that commit (each file is checked against a pinned SHA-256), keeps the forms that are
plain Russian words with two or more vowels and no `ё`, and writes the table: 778,369 usable word forms, 529,820 words kept, 6,405 words left out because the data stresses them two ways
(`--ambiguous first` keeps the first stress in the data instead). The result is 1.5 MB, committed as `packaging/russian-stress/stress-ru.bin` with its record `source.json` (source, commit,
licence, file hashes, counts, digest). Because the file is an adaptation of CC-BY-SA data, the licence travels with it: the pack's `NOTICE.txt` names the source, the licence and the changes, and
`THIRD_PARTY_NOTICES.md` lists it. Format (version 1, `bridge/russian_stress.py`): a header with a SHA-256 of the payload, then zlib of fixed-width records grouped by word length (the word in
Windows-1251, one byte per letter, and the index of the stressed letter), sorted for binary search.

To rebuild the table (the committed one is already built and `--check` tells whether a rebuild would differ):

```powershell
python packaging\build-russian-stress.py --download <cache folder> --out packaging\russian-stress\stress-ru.bin --source-info packaging\russian-stress\source.json
python packaging\build-russian-stress.py --download <cache folder> --check packaging\russian-stress\stress-ru.bin
```

**Building the pack.** The weights come from the model's repository, not from Kyutai's gated one:

```powershell
node packaging\build-pocket-models.mjs --languages ru --russian-source <folder for genvoice/xVibePocketTTS v0.1.0> --out <output folder> --download
```

`--russian-source` is a folder with the repository's files (`config.yaml`, the weights and `tokenizer.model` that it names, and its checksum list). `--download` fetches the missing ones from
the pinned revision. The builder checks each file against the repository's own checksum list, runs the configuration through the same checks as the other languages (six layers, float32,
24 kHz mono, plus `tokenizer: sentencepiece` for the `.model` file), checks the stress table, and writes `PocketTTS-Model-90M-Russian.zip` and its file list under `<output folder>\ru\`.
The weights (442,129,312 bytes, SHA-256 `4f216a0d...9b5a`) and the tokenizer (SHA-256 `ad635e17...ba60`) are pinned in `RUSSIAN_UPSTREAM.pins` in `packaging/build-pocket-models.mjs` (read from the first local build of 1 Nov 2026,
which also matched the repository's checksum list), so a different file stops the build. The repository's checksum list has no line for `config.yaml`: that file is checked line by line when it is relocated instead. A configuration
that names its files with a version tag (`hf://genvoice/xVibePocketTTS/model/model.safetensors@v0.1.0`, as the real one does) is read the same as one with a commit.

**Tests.** `scripts/test_russian_stress.py` (the `+` marks, the table stress on unmarked words, words that are left alone, the format and a damaged file, the build script on small fixtures, the committed
table), `scripts/test_pocket_voice_runtime.py` (`LanguageModels`: `ru` in the list, a `tokenizer.model` asset checked against its hash and relocated, refused under a configuration that does not say
`sentencepiece`, a table read for Russian only and released with the model, the marked text given to the model, the stress module not imported until Russian needs it),
`bridge/pocket-language-models.test.mjs` (`ru` in the list, the Russian manifest and its `expected` hashes, a manifest with the wrong tokenizer or no table refused),
`packaging/pocket-models-build.test.mjs` (the Russian configuration, notice, manifest, zip layout and a build from stand-in files) and `packaging/release.test.mjs` (the pack name).

**Not checked without the real files.** That `config.yaml` has the lines the builder edits (it says so and stops if not), the weights file name (taken from the configuration's `weights_path`),
and how the model sounds with the table's marks on real lines: the owner's check used the model with its own text handling, the dictionary marks are new. Listen to a few lines
(the Russian dub clones, one with a `+` mark, one with a name the table does not know) before the pack is published.

## Cancellation and ownership

The worker's reader can signal cancellation while generation is in progress.
Cancelling releases the caller immediately; the serial inference lane waits for
the native decoder to drain to EOF before a second utterance reuses Mimi. Merely
closing the upstream generator at a yield would skip its decoder join, so the
worker deliberately sets its stop event and drains before closing. A synthesis
exception is terminal: upstream prefill can throw after starting an unjoined
decoder, so that process is retired instead of reused. Reference preparation
failures before synthesis remain recoverable for the other valid profiles.

A cancelled request has `POCKET_LIMITS.cancelMs` (2 s) to be answered before the
worker is retired. The one exception is a voice preparation: a first-time
preparation takes 1.4 to 4.5 s and cannot be interrupted, so a cancelled one gets
`prepareCancelMs` (30 s). The worker finishes it, answers `cancelled` (the
prepared voice stays cached) and takes the next job; V's typed line is cancelled
on purpose when the companion's voice starts, which used to take the worker down
whenever that line met a voice not yet prepared. A stream that has produced no
audio yet is in the same position (it is preparing the voice or reading the text,
neither interruptible), so it gets the long wait too; one that is already
generating stops within a step and keeps the 2 s (0.2.4 report: a V line
cancelled while the worker was starved of CPU took the worker down at 2 s).

The upstream decoder turns every latent frame that is queued when it runs into
ONE chunk, so on a busy computer a chunk can hold seconds of speech. The worker
cuts such a chunk into consecutive packets of at most one second (`PACKET_FRAMES`),
each acknowledged and numbered like any other, all with the chunk's one clock. A
chunk that is empty, not PCM, or would pass the 120 s reply limit still fails
the request (0.2.4 report: "Pocket returned PCM outside its frame limit" for a
five-second chunk retired the worker).

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
