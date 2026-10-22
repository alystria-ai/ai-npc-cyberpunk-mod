# Shared local voices

The Mistral cloud voice (Voxtral, 2026-10-12) is a seventh Companion voices entry that rides on the Pocket route; a reply it cannot deliver in
time is shown as written text, and so is a reply with no key, in a cool-down or in a language it does not speak (never the Convai voice, 2026-10-21): see `docs/CLOUD_VOICE_VOXTRAL.md`.

**No voice ever falls back to a cloud voice (owner rule, 2026-10-21, after a player's report of surprise cloud use; the Voxtral cases were added the same day).** When the chosen
local voice (OmniVoice or Pocket) cannot run, the fallback is a local retry, or the other local voice only if it is already loaded (it is never
loaded for that), and otherwise **text only**: the reply is shown as written text, Convai is asked for text with `ttsEnabled: false`, and
the game says "{voice} is unavailable right now. Replies show as text until it is back." once. The voice comes back by itself when the local
engine recovers (the retries below). The Convai voice is spoken only when the player chose it: Voxtral (the Mistral cloud voice) that fails, has no
key, is cooling down from a refused key or a limit, or gets a reply in a language it does not speak, is written text too, with the same notice and the
same return by itself (`planTurnVoice` / `replyVoice` give the turn the engine `none`). See "Fallback order" below.

## Voice report and reference picker (one page)

`scripts/Reference-Picker.mjs` serves the research listening report and the reference-clip controls on one page. Open the
report, listen, and touch reference audio only for the voices whose generated audio sounds bad.

```
npm run reference-picker            # or: node scripts/Reference-Picker.mjs [--port 8765] [--open]
misc/Reference-Picker.bat           # double-click; opens http://127.0.0.1:8765/
```

The server is headless and long-lived: it never opens a browser unless `--open` is given (the `.bat` does), it listens on
127.0.0.1 only, it writes `runtime/reference-picker.json` (`port`, `pid`, `started`, `url`), and if one is already running
it prints that one's URL and exits 0. Everything is done from buttons on the page; no setup steps. It runs its own
processes with private lock and prompt-cache folders, so a running bridge or game is not disturbed. Generated audio goes to
`E:\CyberpunkConvai-offload\work\reference-picker\` (`samples/`, `refs/`, `logs/`, `pool-index.json`). The live configs
`runtime/pocket-voices.json` and `runtime/local-voices.json` and the research folder
(`E:\CyberpunkConvai-offload\work\likeness-phase1`) are only read. `--fake-render` renders short tones instead of speech
(for trying the page without any model); `--runtime <dir>` moves the log and status file.

**The report.** One row per voice (every voice with research audio, 67 today, plus voices that only have a picker panel):
the game line and every model column, with PLS / ECAPA guard / WER under each column header (from the research
`summary-table.md` and `page/index.html`) and per-voice ECAPA under each cell where it exists. Columns are discovered on every
scan from `out/gen`, `page/audio`, the summary table and the page header, so new research columns (for example Pocket through
the new Mimi decoder) appear on their own when their files land. Layout: Original, Pocket base, Pocket teacher FT, then
matching blocks `1 clip | 2 clips (10 s) | 3 clips (18 s)` for Pocket (student FT), OmniVoice 16 steps and OmniVoice 32
steps (and any Mimi-decoder Pocket), then your own picks, auto-selected, loudness-matched, LoRA and other research renders.
Column groups can be hidden or shown (loudness-matched, LoRA and "other" start hidden). Each row has a line switch (the
two held-out lines), a quick verdict (**Sounds fine** / **Bad, fix references**, undoable) and **Play row**. Keyboard:
Space plays or pauses, the left and right arrows play the previous or next sample in the row, up and down play the same
column on the previous or next voice.

**Reference clips (collapsed under each voice).** Four clip sets per voice, one tab each: Pocket 18 s, Pocket 10 s,
OmniVoice 18 s and OmniVoice 10 s (they start from the research agent's proposed three-clip and 10 s sets). For each:
play every clip (id, length, typicality, loudness against the voice median, flagged beyond +-3 dB), the samples made from
exactly that set, **Reroll** (a different set of whole clips, at most three, joined length within 18 s or 10 s counting 0.4 s
gaps, no clip from the current set when possible, never a rejected set, favouring typical clips close to the voice's median
loudness; the held-out lines are never in a pool), **Choose clips by hand**, **Restore** an earlier set, **Render**, **Keep**
and **Reject** (both toggles with an Undo toast) and a note. Renders appear as "Your picks" columns in the voice's row next
to the research columns and flash briefly when they land.

**Rendering.** Pocket runs on the CPU through the bridge's own `PocketVoice`; OmniVoice runs in a separate persistent
worker (FP16, CUDA, steps 16 and 32; the 10 s set at both). Requests share one queue. OmniVoice renders wait ("GPU busy,
queued") while another process holds most of the GPU (more than 60% of VRAM in use, or under 4.5 GB free; `--gpu-busy-fraction`);
Pocket renders never wait for it.

**Log.** Every action is appended to `runtime/reference-picks.jsonl`, one JSON object per line:
`{"seq", "ts", "voice", "engine", "set", "action", "clips": [ids], "seconds", "note", ...}`. `engine` and `set` are
`pocket`, `pocket-short`, `omni` or `omni-short` (or `all`); `action` is `reroll`, `manual-set`, `restore`, `keep`, `unkeep`,
`reject`, `unreject`, `note`, `verdict` (`fine` / `bad` / empty), `regenerate`, `regenerate-done`, `regenerate-failed` or
`play` (`what` is `research` with the column as `target`, `sample` with the slot, or `clip`). `runtime/reference-picks.json`
is derived from the log: the kept set per voice and engine, verdicts, rejections, notes, current candidate sets, play counts
and each voice's most-played columns. Clip ids are `<voice>/<string id>[/female|male]`.

**Apply the picks.** `node scripts/Apply-ReferencePicks.mjs [--dry-run] [--only voice,voice] [--no-validate]` replays the log
and, for each kept set, concatenates the whole clips into `runtime/voice-references/picked/{pocket,pocket-short,omni,omni-short}/<voice>.wav`
exactly as the research agent's proposed references were built (24 kHz mono 16-bit, torchaudio-style resampling, 0.4 s
of silence between clips, no EQ or denoise) and writes NEW configs by copying the live ones and replacing the kept
voices only: `runtime/pocket-voices.picked.json`, `runtime/pocket-voices.picked-short.json`, `runtime/local-voices.picked.json`
and `runtime/local-voices.picked-short.json`. It then dry-runs each through the bridge's own loaders (Node
`createVoiceProfileRegistry` / `validatePocketConfig`, and the Python `validate_config` of `resident-voice-worker.py`
and `pocket_voice_runtime.py`, including the 20 s Omni reference limit and transcript rules) without loading a model.
It never writes the live configs; switching to a picked config is a separate, approved step.

Tests: `npm run test:reference-picker`.

## The live voice setup — October 7, 2026 (supersedes the October 5 four-choice section below)

**Menu** (Settings > Voices > Companion voices, in this order, fastest to best): Pocket · Performance (default),
OmniVoice · Balanced (16 steps, short reference), OmniVoice · Quality (16 steps, long reference), OmniVoice · High Quality
(32 steps, short reference), OmniVoice · Ultra Quality (32 steps, long reference), Voxtral · Mistral cloud, Convai · Cloud voice
(see docs/CLOUD_VOICE_VOXTRAL.md). Without the Omni pack
the four OmniVoice entries are greyed out (the shown text is dimmed and the arrows skip them; they no longer end in "· needs pack"), the row name gains " (no Omni pack)"
and Apply refuses them. There is no Pocket base. Settings store `voiceProvider` (`pocket`, `omni`, `convai`), `omniSteps` (16 or
32), `omniReference` (`short` up to 10 s of reference audio, `long` up to 18 s) and `keepPreparedVoices` (default on). A fresh
profile starts on Pocket TTS. Migration (`mod/manager.lua`): a saved `omni`/`hybrid` choice keeps its steps and gains
`omniReference = "long"` (whoever chose OmniVoice chose quality; long matches the voice better for about 0.15 s more latency at
16 steps); a saved `pocket` or `convai` stays; a missing or unknown provider becomes Pocket TTS. The description in the menu is three sentences with no
listening percentages: Pocket is light and fast on the CPU (first audio about 0.2 s); OmniVoice sounds better,
especially on harder voices, needs a capable GPU and the optional pack, and the higher tiers take longer to start (about 1 to
2.5 s); Convai uses the cloud, and a local choice that cannot run shows the replies as text with one notice (never a cloud voice). The measured numbers
live here, not in the game: by ear OmniVoice was about 15–20 % better than Pocket at 16 steps and 20–25 % at 32, while for
well-covered voices (Johnny, Judy, Panam, Alex) Pocket is within about 5 %. First audio: Omni 16 about 1.3 s short / 1.45 s
long, Omni 32 about 2.1 s / 2.5 s.

**The local order** (`bridge/voice-selection.mjs`, `VOICE_FALLBACK_ORDER`): OmniVoice, then Pocket; there is no Convai entry. The menu
lists Pocket first, but an Omni choice that cannot run (pack missing, no CUDA, worker failure) is replaced by Pocket only if Pocket is
already loaded, and otherwise by the route `text` (`TEXT_ROUTE`); a Pocket failure is also `text`. The reference choice is part of the Omni worker: a worker holds one reference configuration, so a
change of short/long (at the next idle boundary, like any routing change) releases the worker and starts one on the other
configuration; a change of steps never restarts it. A Settings draft warms the draft's reference before Apply.

**Which files are live.** `runtime/voice-configs.json` (bridge/voice-config-paths.mjs) names the live file for each choice:

```json
{"version": 1, "pocket": "pocket-voices.autobest.json",
 "omni": {"short": "local-voices.autobest-short.json", "long": "local-voices.autobest-long.json"}}
```

Names are plain files in `runtime/`; a missing manifest or file falls back to the base file (`pocket-voices.json`,
`local-voices.json`) with a warning in the bridge log. The other search agent's regenerated files only need to be dropped over
those names (then restart the bridge): `node scripts/Build-AutobestConfigs.mjs` builds them from the base files, which already
carry the new student, so the model identity can't regress. Voices without a searched set keep the base reference.
`node scripts/Switch-VoiceConfigs.mjs` did the switch (backup of the previous live files in
`runtime/backups/voice-configs-2026-10-07/`); it is idempotent.

**Pocket student.** `runtime/pocket-student-v2-s2000-ema-decv2` is a copy of
`E:\CyberpunkConvai-offload\work\pocket-v2\exports\student-v2-s2000-ema-decv2`: the distilled student (EMA weights, update 2,000, run
`pocket-v2-student-11320cda`) with Mimi decoder v2 (phase-anchored, `decoder-v2-phase-anchored-step9590`; the receipt's decoder
hash matches the weights file, and all 44 decoder tensors in `model.safetensors` equal that file). The old student
(`runtime/pocket-student-full-a-s5000-raw`) stays on disk for rollback.

**Optional OmniVoice pack.** `bridge/omni-pack.mjs` checks what the resident worker needs before it can start: its Python
(`vendor/reference-voicestudio/.venv/Scripts/python.exe` or `CYBERPUNK_CONVAI_PYTHON`), the model weights
(`<config.model>/model.safetensors` or `CYBERPUNK_CONVAI_OMNI_MODEL`), the adapter (`.../backend/services/tts_backend.py`) and the
worker script. The bridge publishes `omniPack: {installed, missing}` in `local-voice-state.json` (re-checked every 30 s while
missing). Without the pack the four Omni menu entries are greyed out, Apply refuses them
with "Requires the optional OmniVoice pack (GPU)", a saved Omni choice shows the replies as text with the usual one-time notice (Pocket is not loaded in its place, and no cloud voice speaks), and the Companion voices
row name reads "(no Omni pack)" (the separate "OmniVoice pack" row was removed on 2026-10-14). An unknown status (the service has not reported) never locks an entry. CUDA is not probed up front; a worker
that cannot get a GPU fails at start and the same route (text) applies.

**Keep prepared voices** (Settings > Voices, default on; the bridge picks it up from `settings.json` without a restart).
- Pocket saves each companion's prepared voice state (the encoded reference and its prompt, bit-identical to what encoding
  again gives) to `runtime/pocket-voice-work/prepared-voices/<voice>-<key>.safetensors`. The key hashes voice, reference
  sha256, student model sha256 and the pinned Pocket source; a changed reference or model is a different file and the old one of
  that voice is removed on save. A missing or damaged file is a miss. At most 160 files are kept. Measured: about 0.58 MiB per
  second of reference (7.3 MiB for Judy's 12.7 s, 11.3 MiB for Johnny's 19.6 s, 12.8 MiB for Mr. Hands' 22.1 s).
  Preparation of a voice in a fresh worker: 0.8–1.5 s computed (1.6–3.1 s on a loaded machine) against about 15–20 ms from the
  saved file. Off: nothing is read or written (existing files stay until cleared). Settings > Voices shows **Prepared voices on disk**
  (total size and number of files) and **Clear prepared voices** (opens a page that asks for confirmation, then deletes). The bridge
  measures once when Settings opens, over `runtime/prepared-voices-command.json` and `runtime/prepared-voices-state.json` (the same
  command-file shape as the keys; `bridge/prepared-voices.mjs`), never on a timer or per frame. Only files named exactly
  `<voice>-<24 hex>.safetensors` (or that plus `.tmp`) directly in `prepared-voices` are counted or deleted: never a reference, a model,
  another file, a folder or a link (`bridge/prepared-voices.test.mjs`). `node scripts/Clear-PreparedVoices.mjs [--dry-run]` uses the same
  code from the command line.
- OmniVoice has no saved setup (the adapter re-reads the reference each reply). Its preparation already rendered a hidden warm-up
  phrase while a companion joins, always at 32 steps; with the setting on that render uses the selected steps (about 0.7 s
  instead of 1.0 s at 16 steps, unchanged at 32). The worker keeps one CUDA graph at a time, so a reply whose text has a new
  shape still captures a graph (about 0.35 s); that cost is not removable by warming.

Measurements: `node scripts/Measure-VoiceStartup.mjs pocket|omni ...` (real workers, game closed).

## Four global voice choices — October 5 (historical; see the section above)

Listening tests put OmniVoice (GPU, `k2-fsa/OmniVoice`) closest to the real
characters, and the fine-tuned Pocket student was no better than stock Pocket
(speaker similarity 0.930 against 0.926 on 77 voices, within noise). The
selector was therefore reduced to one global setting with four choices, in this
order: **OmniVoice 16 steps (default), OmniVoice 32 steps, Pocket TTS, Convai
cloud voice** (the live menu now has six entries with Pocket as the default; see the section above). 16 steps was made the default after research showed it equals 32
on every perceptual metric at half the GPU time. Earlier lists (Pocket first, and separate student/teacher or
fine-tuning variants) are gone. There is no separate quality row and no
per-character voice selector.

Settings store `voiceProvider` as `pocket`, `omni` or `convai`, with retained
`omniSteps` of 16 or 32 (default 16); the names are unchanged so older saves
keep working. Select index 1 is `omni`/16, 2 is `omni`/32, 3 is `pocket`, 4 is
`convai`. Those numbers are Omni generation steps, not precision. 32 versus 16
changes only the step count; the bridge's Omni configuration (FP16, CUDA,
guidance, seed) is otherwise identical. Both Omni choices reuse the same
accepted FP16 CUDA ResidentVoice model and reference cache. The Pocket choice is
the six-layer student at CFG 1, one decode step, temperature 0.3.

### Migration

`mod/manager.lua` maps a saved `voiceProvider` once, on load, and rewrites
`runtime/settings.json`: `convai` stays Convai; any name containing `pocket`
(`pocket`, `pocket-student`, `pocket-base`, ...) becomes Pocket TTS; `omni`,
`omnivoice` and the older `hybrid` become OmniVoice; anything else (missing,
empty, a number, `teacher`, ...) becomes the default OmniVoice. An invalid
`omniSteps` becomes 16; a saved 32 stays 32. Because the old default was Pocket, a player who never
changed the setting keeps Pocket until they pick another voice.

### Fallback order

The local voices are OmniVoice, then Pocket TTS. **No cloud voice is ever a fallback for them.** A choice that cannot run is replaced by
the other local voice only when that one is already loaded (never loaded for the purpose), and otherwise by the route **`text`**: no
voice speaks, and each reply is shown as written text (`planTurnVoice` gives the turn the engine `none`, Convai is asked with
`ttsEnabled: false`, the reply carries `audioError`, and the routing log says `used="none (written reply only)"` with the reason).
The Convai voice (`provider: "convai"`) is a route only when the player chose it (`VoiceSelection.convaiVoiceAllowed`); Voxtral with no key or no
route is text as well. Convai text turns carry `ttsEnabled: false` whenever the chosen voice is not the Convai voice (`convaiSpeaks` in the bridge).
"Cannot run" means the backend is not configured (a machine with no Pocket setup at all included), none of its references is
available, or its worker failed (for example no CUDA GPU, OmniVoice failing to
load, a crashed worker). A failed worker stays out of routing until the player
chooses that provider again, and is not restarted in a loop. The exception since
October 10 is OmniVoice: it is loaded again in the background after 45 s, 3 min
and 10 min, and takes its place back at an idle boundary ("Startup limit, background retry and switch back" below); Pocket
gets the same three waits (see "Pocket retries too" there). The route change
commits at the next idle settings poll, like any routing change, so a turn in
progress keeps its voice. The bridge publishes `fallback: {from, to}` (`to: "text"`; with `temporary: true` while a retry is pending) in
`runtime/local-voice-state.json` (and the support report) once the text-only route is
committed; the CET mod reads it and posts one gameplay notice per
fallback ("OmniVoice · Balanced is unavailable right now. Replies show as text until it is back."), the same words for a temporary and a
lasting case. Invitations
that were preparing against the failed backend continue with a `{provider: "text", ready: true}` receipt instead
of failing (the companion joins; its replies are written). The pre-existing readiness and availability checks are unchanged.
Multilingual conversations are the same: Pocket speaks English only (and the five languages that have an installed Pocket model and voice language pack, docs/POCKET_LANGUAGE_MODELS.md), so a reply in any other
language on Pocket is shown as text, not read by Pocket and not handed to the Convai voice.

Pocket uses **float32 on CPU**, with four inference threads, one
shared model and per-character acoustic reference states. It does not load the
teacher, allocate CUDA memory, use TensorRT or create a neural model per
character. This trained student is English. The selected weight file is
**438,033,312 bytes (417.74 MiB)**.

The source integration has 75 available character references. Johnny uses the
approved 22.286-second original-dialogue montage; Judy and Panam retain their
approved original recordings. The remaining cast uses its existing attributed
references. The four unprepared profiles are written (shown as text) while a local voice is chosen; they are never given to the Convai voice.
No cloned/generated speech is used as a reference.

- Selecting any local option requests preparation from an unsaved Settings
  draft. A cross-backend request waits for an owned reply and confirmed worker
  retirement before loading the replacement; CPU/CUDA models do not overlap.
  Saving the choice keeps that prepared worker; discarding changes or leaving
  Settings without saving releases preview-only residency. A saved Convai
  choice starts without a local model.
- Switching Omni16↔32 updates the captured steps for the next reply without
  reloading model weights or reference states. Pocket and Omni have separate
  verified registries: approved Pocket Johnny22 does not overwrite Omni's
  accepted short reference.
- Invite prepares the character's acoustic state, memory and connection before
  allowing the world copy to spawn. Eight reference states are cached; they can
  be re-encoded from their own verified recording after eviction.
- Convai generates the original reply text once. Pocket receives the complete
  reply once and yields real PCM decoder chunks. One continuous renderer begins
  from an accepted prefix and returns only after the device drains. There is no
  application-level text splitting, full-WAV playback gate, denoising, gain
  normalization, pitch/speed change, fades or crossfades.
- Omni retains the accepted native WAV phrase producer. Its first phrase can
  begin before later phrases finish synthesis; the same original Convai reply
  and captured16/32 setting remain owned through all phrases. Convai PCM never
  enters that splitter, and Pocket remains on its own continuous decoder.
- Native lips use the existing phonetic/native-shape mapping. Pocket's prepared
  path uses resident CPU allphone analysis on copied PCM, warmed alongside voice
  preparation; Omni has no phrase analyser beside the facial model (Rhubarb was removed 2026-10-21; a phrase without cues plays on the audio envelope). Audio never waits for local
  lip analysis. Faces, subtitles and audible drain share the renderer's consumed
  sample clock and exact request/entity/generation owner.
- Cancellation stops the owned native generator, drains its decoder to actual
  EOF and retains serial ownership until physical cleanup completes. Shutdown
  has bounded owned-child/self-exit recovery; an unconfirmed exit prevents a
  replacement model from starting.
- Voice playback Off sends one identified text-only turn without running either
  local renderer or requesting Convai TTS. A character with no usable reference
  has its reply written (it is not given to the Convai voice); a local failure preserves the written reply
  without borrowing a different character's recording.

**Qualification:** the student was approved from listening samples and measured
on the verified WSL CPU runtime. The new source worker/client, ownership,
selection, face/stream and real muted-browser tests pass. An actual native Windows
student check passed incremental output, physical cancellation, cached-reference
reuse and confirmed shutdown. A combined native student/muted Edge/Rhubarb check
played a prefix before generation completed, used phonetic lip shapes, drained
the exact sample count with zero underruns and returned the mouth to neutral.
Live Pocket voice playback is confirmed. Its first facial game check exposed a
legacy Convai-only Lua source assertion; that seam is corrected and covered by
the actual JS prefix→Lua continuous consumer regression. Current visual
acceptance and the restored four-option switching check remain separate from
source tests. Packaging remains deferred.

See [Pocket runtime](POCKET_TTS_RUNTIME.md) for the verified asset contract,
stream API, development setup and current runtime limitations. The original
experimental exports and their receipts remain unchanged; user adoption is a
separate local receipt.

### Startup limit, background retry and switch back — October 10

Cause of the morning's downgrade: OmniVoice startup had one fixed 180 s limit, and a start takes about 3 minutes on a
CPU-throttled laptop (Windows Silent power mode) even with nothing else running; at game launch it also competes with the
game's own loading. The worker timed out ("Local voice startup timed out"), the failed backend left routing for the rest of the
session ("A failed worker stays out of routing until the player chooses that provider again"), and Pocket served every reply.

- **Startup limit** (`VOICE_WORKER_LIMITS` in `bridge/resident-voice.mjs`). The worker restarts a **300 s stall window** with every
  frame it sends (`resident-voice-worker.py` now reports a `loading` state at each stage: libraries imported, model loaded,
  CUDA graph ready, then one `warming` frame per profile) and with every line its libraries log (weight-loading bars). Only
  300 s of silence, or an absolute **900 s**, ends a start. A worker that is asked to stop while still loading gets 60 s.
  A render keeps its 120 s limit.
- **Failure is temporary.** When the chosen OmniVoice fails or times out (crash, no CUDA, stall), routing falls to the next voice
  as before (`fallback: {from, to, temporary: true}` in `runtime/local-voice-state.json`), and `VoiceSelection` schedules a
  background retry: after **45 s**, then **3 min**, then **10 min**. A fourth failure gives up: the plain fallback stays until
  the player chooses OmniVoice again (as before). Choosing another voice, changing the reference set, the pack going missing or
  closing the service drops a pending retry or a loading background worker.
- **Not enough graphics memory next to the game (2026-10-22).** A timeout (or an out-of-memory error) together with graphics memory that spilled into shared system memory
  (the worker's own reading when a preparation or render ran out of time, `bridge/gpu-memory.mjs` `spillVerdict`), or on an NVIDIA card of 8 GB or less (the same lazy card list as
  `gpu-vendors.mjs`, read only once OmniVoice is wanted), is not retried: reports of an RTX 4060 Ti 8 GB showed `Local voice startup timed out` / `preparation timed out` with 2,036 MiB on the
  card and 518 MiB shared, every 45 s. `VoiceSelection.omniNoMemory` is set for the life of the service (like `omniNoCuda`), `[OmniRetry] not trying again: not enough graphics memory ...` is
  logged once, and Pocket is loaded in OmniVoice's place (`resolve`): `fallback: {from: 'omni', to: 'pocket', reason: 'omni-memory'}`, announced once by `mod/manager.lua`
  ("OmniVoice needs more graphics memory than is free next to the game. Pocket is used."). A plain timeout on a bigger card with nothing spilled gets ONE retry; a second one gives up
  (replies as text). The voice row says "(OmniVoice needs 12 GB)" when the NVIDIA card is known to be under 11 GB (`omniSmallCard`).
  **Not started at all on 8 GB or less (2026-10-22, owner decision).** On an NVIDIA card under 9,000 MiB (`isSmallCard`) OmniVoice is never started: `VoiceSelection.omniNoMemory` is a getter now (`omniMemoryFailed` || `omniCardTooSmall`), so `resolve`, `pocketWanted` and the `omni-memory` fallback act at once, without waiting for a timeout (the 8 GB laptop of the 22 Oct reports waited 4 minutes for V's first line). One log line `[OmniVoice] not starting OmniVoice: the card has N MiB ...`, the same single in-game notice as a failed start, no error report (nothing failed). The saved setting stays OmniVoice (`requestedProvider`), so a bigger card later just works. While the card list is still being read (`gpuMemoryMiB` answers `undefined`, a registry query of well under a second at the first time OmniVoice is wanted) the worker is held back (`omniCardPending` in `targetBackend`); an unknown card (list read, no size) starts OmniVoice as before. A cloud voice chosen: the card is not asked about and no local model loads.
- **Windows out of memory: the paging file is too small (2026-10-22 evening; install `efde3b`, reports `7a95278d`, `24332da7`, `d00cebaf`).** Error 1455 (`ERROR_COMMITMENT_LIMIT`: RAM plus the paging file used up, beside the game, Local AI and several Python models) killed OmniVoice, Pocket and V's helper Pocket in `safetensors safe_open`, in a scipy DLL import and in `import torch`, with access violations (3221225477) in the workers that died mid-load. `pagingFileFailed` (`bridge/voice-failures.mjs`) recognises the words, the code, or an access violation that comes with a 1455 line, and `stderrReason` puts the paging-file line first so the failure message carries it. It is in `permanentVoiceFailure`, the same branch as a Windows policy or a missing file: `[OmniRetry]` / `[PocketRetry]` / `[VHelper]` log `not trying again: Windows ran out of memory for the voice (the paging file is too small)` once, no 45 s / 180 s reloads and no CUDA-graph-off retry. OmniVoice falls to Pocket (`omniPagingFailed` is part of `omniNoMemory`, but not of `omniSmallCard`, so the menu does not claim a small card); if Pocket fails the same way (`pocketPagingFailed`) the reply is written. The fallback carries `reason: 'virtual-memory'` and `mod/manager.lua` says once "Windows ran out of memory for the voice. A larger paging file or closing other apps helps." (15 languages); the same sentence is the Help row of the voice (`voiceProblem().cause` `virtual-memory`, `mod/setup-check.lua`). Choosing the voice again tries it once more. The error report's `system` block now carries `totalRamMiB` and `commitLimitMiB` (`cachedMemoryFacts` in `bridge/setup-check.mjs`: Node's own RAM reading and one PowerShell `Win32_OperatingSystem` read per bridge process, made when a report is built).
- **How the retry runs.** `omniRetry: {failures, loading, nextInMs}` is published. No timer and no loop: `VoiceSelection.update`
  (the existing 500 ms settings poll) checks whether a retry is due. A due retry waits for a moment with no reply in flight and
  for the failed worker's confirmed exit, then loads OmniVoice in a second, **below-normal-priority** worker
  (`os.setPriority`; raised to normal once ready, because rendering is latency-sensitive) beside the live Pocket worker. The
  load happens in the background and shows only as `omniRetry.loading`; a bridge log line `[OmniRetry] ...` records each step.
- **Switch back.** When the background worker is ready, OmniVoice is routable again (`pending`), but the commit follows the normal
  rule: the next idle settings poll, never while a reply is in flight. At that commit the provider returns to OmniVoice, the loaded
  worker is **adopted** (the model is not loaded a second time), and the Pocket worker is released. Nothing is announced.
- **Memory.** Pocket runs on the CPU (`CUDA_VISIBLE_DEVICES=-1`, 0 VRAM), so the loading OmniVoice worker never shares VRAM with
  another model. While it loads, Pocket's CPU RAM (one 418 MiB student) and the loading worker are both resident; Pocket is
  released at the switch. Only one OmniVoice worker exists at a time (the shared `resident-model.lock` still forbids two).
- **What the player sees.** One gameplay notice when Pocket starts serving: "OmniVoice · Balanced is not ready yet. Companions are
  using Pocket · Performance for now." (the same 600 s repeat window as the permanent text). Silence on the way back. If the retries
  run out, the permanent "is unavailable" text follows. The Settings status line reads "Using Pocket, OmniVoice not ready yet".
  See [NOTIFICATIONS.md](NOTIFICATIONS.md).
- **Pocket retries too.** Pocket's own startup (`POCKET_LIMITS.startupMs`, 180 s, CPU only, with the stall watchdog's second attempt)
  keeps its limit, but a Pocket that still fails (a stalled start while the game loads, a crash) is no longer lost for the session:
  `VoiceSelection` schedules the same waits (**45 s**, **3 min**, **10 min**; a fourth failure gives up until the player chooses Pocket
  again), published as `pocketRetry: {failures, loading, nextInMs}` and logged as `[PocketRetry] ...`, with `fallback.temporary: true`
  while it runs. There is no background candidate (the route it falls to, text, loads nothing): when a retry is due, with no reply in
  flight and voice playback not Off (V's typed line counts), the failure is cleared and the normal start loads Pocket again; the route
  returns at the next idle poll. The failed worker is released when it fails. The story ends, and nothing loads, when the player chooses
  another voice or a cloud voice, or the service closes.

## OmniVoice implementation and historical measurements

The restored Omni choices use this accepted GPU implementation. Historical
measurements below retain their original conditions; Pocket remains the new-user
default, and its current details are in the section above.

The former local route was **base OmniVoice, 32 generation steps by default**,
with 16 steps available in Companion Manager → Settings → Local voice quality. Both settings
use **FP16 on CUDA through PyTorch**, without TensorRT or `torch.compile`.
The numbers 16 and 32 describe generation steps, not floating-point precision.

September 29: the worker now uses bounded CUDA graph replay around the original
FP16 forward. See [VOICE_ACCELERATION.md](VOICE_ACCELERATION.md) for comparable
timings, memory definitions, exact-WAV checks, fallback and the bridge-only
opt-out. FP8 remains an isolated candidate, not the installed voice precision.

## Routing and lifetime

- **Companion Manager → Settings → Companion voices** selects Pocket ·
  Performance (default), one of four OmniVoice quality tiers (Balanced, Quality, High Quality, Ultra Quality) or Convai ·
  Cloud voice. The manager uses the player's assigned
  CET shortcut. Saving the selection keeps it for future launches; valid saved
  choices take precedence over the new-user default.
- The current catalog has **75 prepared local voice profiles** out of 79.
  Convai generates their reply text, and one shared OmniVoice model produces
  speech from attributed game recordings. The four profiles without prepared
  references—8ug8ear, Jake Estevez, NC Resident Male and NC Resident Female—have
  their replies shown as text while a local voice is chosen (never in a cloud voice).
  Choosing Convai uses online voices for all characters.
- While OmniVoice is selected, the bridge starts one hidden worker. Lazy
  conditioning prepares Johnny, Judy and Panam at startup, then prepares other
  profiles on invitation or when speech needs them. At most **eight conditioning
  prompts** are cached in memory; an evicted profile can be prepared again from
  its own reference. The shared model stays loaded without idle eviction.
  Changing steps updates the next reply without reloading weights.
- October 1: switching the MCM selector to OmniVoice begins that preparation
  from the draft immediately, before the change is saved. Saving reuses the
  prepared worker; discarding changes or leaving Settings without saving
  cancels preview-only residency. Current replies keep their original route.
  See [VOICE_PREPARATION.md](VOICE_PREPARATION.md).
- Selecting Convai waits for the current conversation reply (including every
  streamed phrase or microphone response) to finish. Subsequent replies use the
  character's configured Convai voice (the player chose it). The old worker finishes outstanding CUDA
  work and exits through EOF, releasing its GPU allocation. Status distinguishes
  a pending change, releasing memory, and a fully unloaded model.
- Switching back warms one new worker only after the old worker exits. Rapid
  toggles cannot overlap workers. Native audio already prepared can finish
  playing while the model is released. None of these changes restart the game.
- Only one GPU render runs at once. Cancelling a turn discards its audio, but
  retains ownership of the worker until that render finishes. Queued cancelled
  work is skipped. Shutdown uses pipe EOF. A phrase render has a 120-second
  deadline; startup is progress-based (see "Startup limit, background retry and
  switch back" below). After completion or timeout, shutdown
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

## Several voices per profile

An ambient profile (an unnamed-NPC archetype such as `npc-maelstrom-male`, or `resident-male` / `resident-female`) can
have several local voices, so two pedestrians of one kind do not sound alike. Code: `bridge/voice-variants.mjs`.

- **Naming.** Variant 1 is the profile key itself. Further voices are registered in the same voice configurations
  (`pocket-voices.autobest.json`, `local-voices.autobest-short.json`, `-long.json`) as `<profileKey>-v2`, `-v3` and `-v4`
  (for example `npc-maelstrom-male`, `npc-maelstrom-male-v2`). A variant key is a voice-registry entry only: it is not a
  profile, has no Convai character and never appears as a conversation profile, a route or warm key, or in the
  `configuredProfiles` / `routedProfiles` lists of `local-voice-state.json`. The registries and workers do load them.
- **Which voice speaks.** The pick is deterministic and made once per reply. The seed is the NPC's stable identity: the
  vendor's shop record (`archetype.memoryKey`, set for one-shop vendors) when there is one, otherwise the actor entity
  (for example `123456ULL`). The voice is the SHA-256 of `<profileKey>|<seed>` taken modulo the number of variants the
  current backend can actually speak (Pocket, or the Omni reference set in use), so the same pedestrian keeps the same
  voice across lines and restarts, and different pedestrians spread over the variants. Every phrase, look-ahead and
  prefetch of one reply uses that one voice.
- **Routing stays on the base profile.** Whether a profile is spoken locally, by which provider, whether it is ready,
  the Convai fallback and multilingual planning all ask about the base key; only the voice that is synthesized uses the
  variant key. Named characters have no variants and are unaffected, and the Convai cloud voice stays one voice per
  character.
- **Fallback.** A variant the current backend cannot speak (missing, unavailable or an unprepared reference) is left out of
  the draw. With no usable variant, or no seed, the base key speaks. A variant never falls back to another character.
- **Preparation.** Variants are prepared lazily on first use like any other non-startup profile (startup warms only
  Johnny, Judy and Panam on Omni and nothing on Pocket). The in-memory conditioning cache still holds at most eight
  voices (`maxCachedProfiles`); with Keep prepared voices on, Pocket's saved setups make a returning voice quick.
- **Limit.** A voice configuration may hold up to **1024** voices (profiles plus variants); it was 256. The same limit is
  in the Node registry (`VOICE_PROFILE_LIMITS.profiles`) and both Python workers.

## V's own voice entries

Two more entries sit in the same voice configurations: `v-male` and `v-female`, merged at bridge start from the reference
clips in `assets/v-voice` (or `voice-references/v-voice` when installed) the way an add-on's voice is (copied to
`voice-references/addons/<key>.wav`, written into the `addons.<name>` copies of the configurations, prepared lazily). They are
not profiles and never speak for a companion: only the setting "V's voice for typed lines" uses them. See `docs/V_VOICE.md`.

With V's engine set to OmniVoice (2026-10-21; only while OmniVoice is the companions' voice) `v-male` / `v-female` are rendered by the Omni worker itself,
at 16 steps, queued ahead of the companion's own render (`VoiceSelection.vOmniRender`): no second worker and no Pocket worker for V. Warm render times on the
RTX 4080 Laptop (long reference, 16 steps): about 0.76 s for a 4 s line, 0.90 s for a 7 s line, 0.97 s for a 9 s line (32 steps: 1.0, 1.4, 1.6 s); preparing V's
voice takes about 0.8 s once per worker, and V's voice counts as one of the worker's 8 prepared prompts. The worker renders one job at a time and a started render cannot be
cancelled, so a companion phrase queued behind V's line finishes about 0.8 s later than it would alone (plus about 0.2 s when the text length changes the CUDA graph).
Measured standalone with `ResidentVoice` and the player install's pack; see docs/V_VOICE.md, "V on OmniVoice".

## Player voice clips

A player can give a story character, or a character they made, a reference clip of their own in the character editor (docs/CHARACTER_EDITOR.md, "Voice clips"). The clip stays in the data folder: `<state>/player-voices/<key>.wav` (canonical mono 16-bit PCM) with the words said in it in `<state>/player-voices.json` (`bridge/player-voices.mjs`). At service start each clip joins V's voices as an `extra` of `AddonHost.voiceConfigPaths` with `player: true`, but it is never copied: its descriptor is `runtime/player-voices/<key>.wav`, a second reference namespace that Pocket (`runtime.playerVoiceDirectory`), OmniVoice (top-level `playerVoiceDirectory`) and Voxtral (`playerRoot`) resolve only inside the player folder, with the same containment, link, hash, WAV and 20-second checks as the shipped references. A clip **replaces** the shipped voice of its key in every merged configuration and is taken out of `preparation.startupProfiles`, so it is prepared only when that character speaks. Voxtral keeps its prepared slot of a player clip in `<state>/player-voices-prepared`. A clip given or removed while the service runs counts from that character's next line, with no restart: see "Changing a clip while the service runs" in docs/CHARACTER_EDITOR.md (`bridge/live-voices.mjs` edits that one key in the three voice tables and `VoiceSelection.setVoices` sends the running workers the difference). With the clip removed, the shipped voice is back.

## Voices of characters the player makes

A character made in the character editor (docs/CHARACTER_EDITOR.md, "Your own characters", key `custom-<slug>-<letters>`) is not a profile of the shipped cast, so it has no entry in the voice configurations of the package. Two things give it a voice:

- **Its own clip.** A player voice clip (above).
- **No clip yet (or none at all).** `VoiceSelection` takes an `aliases(key)` option (the bridge: `customCharacters.voiceAlias`): a key with no voice of its own is routed, prepared and synthesised as `resident-female` or `resident-male` by gender. The variant (`-v2`, `-v3`) is picked from the character's own key (`voiceKeyFor` uses the key as the seed for an aliased key), so one character keeps one voice across spawns and sessions.

With the Convai cloud voice chosen there is no voice for such a character; its replies are subtitles only.

## Local setup and operation

### Full-cast reference activation — October 1

The wider-cast configuration replaces the original Johnny/Judy/Panam-only
scope. It includes those three unchanged accepted descriptors plus 72 additional
source-qualified descriptors. Preparation checks actor attribution, reference
bytes, transcript and identity; the user authorized activation without another
listening-approval gate. This does not claim every generated voice matches the
original performance. See [VOICE_SOURCE_ACTIVATION.md](VOICE_SOURCE_ACTIVATION.md)
for the activation contract and the [TODO list](../TODO.md)
for the catalog history and current installed state.

Characters share the same pretrained weights. A profile adds a recording,
transcript and cached conditioning prompt, rather than a separate fine-tuned
model. The version 2 registry uses lazy preparation, three startup profiles and
an eight-prompt memory cache. Invite prepares the selected profile before spawn
permission. A missing or unprepared reference gets the receipt `{provider: "text", ready: true}`: the companion joins and its replies are written.

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
