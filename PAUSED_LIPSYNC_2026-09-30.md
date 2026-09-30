# Paused: native lip-sync review and update

The user explicitly paused work on September 30 and will return in a few hours.
No scheduled wake-up was requested. Stop work until the user resumes.

## Current state

- Source checkpoint: **`ee1e6b8`**, `fix(lipsync): preserve native articulation and heard-frame cadence`.
- Lua/catalogues were installed and hash verified with `-LuaOnly` immediately
  before the pause. Receipt:
  `backups/development-install-20260930-165214-eda774c44092472e93fcca4e48c6cca6/manifest.json`.
- The reply bridge and game were not running at the last process check.
  **They have not been launched after this installation.** The voice browser
  bundle has not been rebuilt after the v4 change; the ordinary bridge launcher
  rebuilds it automatically before starting the owned hidden worker.
- No native graph/archive/redscript changes were required or installed.
- The new code has **not** been accepted visually in the game. Do not claim the
  wooden/small mouth complaint is resolved.
- All research agents completed or were interrupted on pause. No GPU inference,
  new provider conversations, new user IDs or memory writes were used for this
  review. No game input or computer use was performed.

## Latest accepted user feedback and intent

- Continuous Convai voice latency is now good; preserve the original continuous
  PCM path and keep it separate from Omni phrase generation.
- The mouth still looks wooden and barely moves.
- The user approved understanding Cyberpunk's native facial system and improving
  the mapping. They requested a deep dive into available lip-sync options.
- Preserve the accepted movement, close approach, menus, phone UI, native
  subtitles and voice choices. No additional GPU model was selected.

## Implemented correction

### Cadence

The real Lua replay reproduced only 20 native facial applications per second at
60 game FPS because the 40 ms file poll reset its remainder and the speech owner
returned between polls. The new face cursor samples each game frame, never ahead
of the most recent confirmed already-heard audio position. Ordinary past lag was
33–38 ms; catch-up is bounded to 80 ms of past audio. Exact 60 Hz float roundoff
and repeated timeline publications no longer cause skips or bypass the cap.

Two-second before/after applications: 30 FPS **30→59**, 60 FPS **40→115**,
120 FPS **48→115**. Pause/buffering, held/missing reports, actor loss, unload,
resume and final audible-drain cleanup remain guarded. Native Omni phrase
behavior and subtitle timestamps are unchanged.

### Native retarget

`arkit61-native-v4` keeps the previous jaw/aperture/closure curves and upper-raiser
safety. It splits the existing 0.20 stretch coefficient into 0.12 inner-lip
stretch plus 0.08 actual corner stretch, and maps ARKit lower-lip roll to
`0.20 * MouthRollLower` through native `lips_suck_dn`.

Actual Judy and Johnny rigs were evaluated on CPU. The old stretch target has
a different footprint than true corner stretch; lower roll was discarded.
The candidate changes spatial detail without a broad amplitude increase.
This is a controlled mapping change, **not a substantial opening increase**.

Native mouth closure can suppress jaw/aperture, and the additive graph retains
native idle animation. MouthClose is independent of jaw in ARKit, but our current
gate remains for this comparison. Combined contact calibration and the actual
animated baseline remain unproven; do not adjust every gain or JALI envelope
without evidence.

## Evidence and documentation

- `docs/LIPSYNC_DEEP_DIVE_2026-09-30.md`: primary-source options, native solver,
  resource/licensing limits, mapping and sampling findings, verification method.
- `docs/NATIVE_FACIAL_RETARGET_CALIBRATION.md`: actual native geometry, SDK61
  ordering, bounded target choices, reusable CPU inspector and closure limits.
- `scripts/Inspect-NativeFacialRig.py`: authored CLI; imports a separately
  supplied upstream NumPy solver in place, without Blender registration.
- `docs/CONVAI_AUDIO_STREAMING.md`, `docs/LIPSYNC_REFINEMENT.md`,
  `docs/DEVELOPMENT_AUDIT_2026-09-30.md` and `TODO.md` were updated.
- Combined focused checks: **122 passed, zero failures/skips**. Includes actual
  JavaScript publisher/builder data through Lua to native-feature fields and
  cleanup, not only fabricated schema fixtures.
- Numerical log: `runtime/lipsync-native-20260930-tests.log`.
- Cadence evidence: `runtime/facial-cadence-audit-20260930.json`.
- Judy extracted setup/rig and 443-pose replay:
  `runtime/facial-native-audit-20260930`.
- Johnny independent qualification:
  `runtime/facial-native-johnny-20260930`, including
  `retained-replay-report.json` and `retained-replay-summary.json`.

The last Johnny replay completed just before pause and is retained in ignored
runtime files. Its current→candidate max translation was 8.5947→8.5948 mm and
max local rotation 14.652→14.309 degrees; corner differences reached about
0.53/0.59 mm. This supports a bounded shape change, not rendered acceptance.
Local transforms do not include full skinning or the actual live idle baseline.

Game-derived binaries/JSON, source audio, private runtime/config and reference
checkouts remain ignored. The upstream solver is not bundled under an assumed
license. No push, release or upload occurred.

## Codex setting request

The global config now contains `model_context_window = 1000000`, with a backup
under `C:\Users\akshi\.codex\backups\config-before-1m-20260930-161539.toml`.
After the user restarted Codex, live token telemetry confirmed **828400 effective
tokens** for the parent and all four newly created lip-sync agents. Their actual
turn metadata was **gpt-6.1-sol / ultra**, inherited without overrides. The
catalogue's raw maximum was 872000 with 95 percent usable context. Do not reuse
older smaller-context workers and claim the change applied to them.

## Resume boundaries

The source/install work is ready; activation and one focused speaking-face
observation remain outstanding. The user's standing preference is to launch
the game EXE after fixes so they do not have to do that step. On resume, inspect
current process/source state first and use the existing hidden bridge launcher;
avoid an unnecessary game restart if it is already open. No power-profile change
is necessary for Convai-only facial checking. Keep the same player identity.

Never read, edit, execute, stage, delete or move the user-owned untracked
`scripts/Test-GameInput.ps1`. Keep credentials and IDs out of tool output.
