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
