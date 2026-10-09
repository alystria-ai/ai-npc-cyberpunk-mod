# Native facial animation

> **October 5:** local voices and continuous Convai speech now use a model trained on the game's own JALI dialogue lipsync when local weights exist; see [GAME_LIPSYNC_MODEL.md](GAME_LIPSYNC_MODEL.md). The paths below remain the fallback.

> **October 8: world NPCs, on demand.** The layer is no longer companion-only, but nothing is prepared at spawn (FPS): a running `face_rig` cannot change its graph in place, so when a conversation opens `init.lua` calls `NPCPuppet.ConvaiFaceRequest()` on the talk target. `ConvaiFaceService.RequestWorldFace` checks the running face without writing it, queues the NPC's current appearance name and rebuilds that same appearance (`ScheduleAppearanceChange`). The `Entity/Extract` callback prepares the matching appearance-only rebuild, the same seam that replaced Johnny's face on October 2. `ConvaiFaceReady()` then adopts the world NPC from its running graph path; a dynamic entity still needs the `CyberpunkConvaiCompanion` tag. At most two world NPCs keep the layer; a third request rebuilds the oldest back to vanilla. NPCs in a dialogue, quest-owned NPCs (`q###`, `sq###` or `mq###` in the appearance name or TweakDB record), quest-marked or non-autonomous ones, and scene NPCs that are neither vendor nor crowd are never rebuilt (October 9, after a Konpeki receptionist from `q004` was; on October 10 a scene alone stopped blocking vendors, see [WORLD_COMPANIONS.md](WORLD_COMPANIONS.md)). Every other NPC keeps the vanilla graph. In Lua, speech playback writes to whoever `speech.lua` is voicing (`speaker()`), and idle, thinking and listening faces stay on managed companions (`owns()`). Not yet proven in game: that a same-name appearance change really rebuilds `face_rig`, and that the rebuild is not visible. The vanilla graphs offer no zero-cost alternative: their only script input is the `AnimFeature_FacialReaction` mood preset, and vanilla lip sync comes from authored scene/VO animations. Statements below that the layer is for owned companions only date from before this change.

## October 2: facial graph lifetime across appearance changes

Johnny's seated reply delivered 186 facial applications and a reset, but the
read-only component receipt showed the original `man_average_sermo` graph:
274 nodes and no `ConvaiFace` inputs. His physical appearance change had replaced
the prepared face component. A latched readiness flag made accepted feature
events look successful even though that graph could not consume the feature.

The service prepares extracted template, appearance and custom-appearance
component instances when the builder request has a managed entity ID. The
`Entity/Initialize` callback repeats the dynamic tag check before initial native
component initialization. The source compiled and its initial 74 focused checks
passed, but a fresh Johnny game check exposed an important missing case: the
physical appearance still replaced the prepared component after attachment.

A bounded live `Entity/Extract` trace resolved the cause. Requests for both
`silverhand_default` and `silverhand_riot__not_blendable` reported entity ID
`0ULL`, `HasEntity=false`, `HasAppearance=true`, and no dynamic tag. Those
appearance-only builders provide no authoritative copy identity to this
callback. Their components remain untouched; matching an appearance name or
character record would also match original story actors.

Johnny's private spawn record now returns the solid appearance confirmed by
his template's phantom mapping. `companions.lua` puts
`silverhand_riot__not_blendable` in the initial `DynamicEntitySpec` before
`CreateEntity`. Native initialization therefore prepares the final face rig,
and attachment disables the phantom controller without requesting another
appearance. Cached record reuse, model-browser aliases and missing-copy
recreation after fast travel use the same choice. The choice follows the model
record, so assigning Johnny's conversation profile to another model does not
change that model's appearance.

`ConvaiFaceReady()` also checks the current `face_rig` graph's load/failure state
and exact prepared path. Replacing it can no longer leave the old flag sufficient
for accepting facial frames. The service retains no actor/component handles,
and speech and expressions still share one writer.

The two new production-Lua regressions failed before the spawn fix and pass
after it; 51 affected behavior, record, vehicle-integration and facial-graph
checks pass. The native facial source was unchanged by this correction. Live
acceptance still requires a fresh Johnny with the prepared active graph, a
seated voiced reply and its reset. Compilation and frame counts alone do not
confirm motion.
Codeware's pinned [builder wrappers](https://github.com/psiberx/cp2077-codeware/blob/v1.20.5/src/App/Entity/EntityBuilderWrapper.hpp)
expose the extracted component instances used by this preparation.

Independent review of the installed Johnny assets places `face_rig` in each
relevant `.app` appearance, with obligatory graph/rig dependencies. Official
Codeware 1.20.5 source confirms that this extraction seam exposes builder-local
component results before aggregation and initialization. This qualifies
preparation only when the builder supplies a managed ID. General ownerless
appearance rebuilds and arbitrary engine reuse of an initialized component
remain outside that source proof. `ConvaiFaceReady()` reports false when such
a rebuild replaces the prepared graph, without rewriting a running component.

## Historical status — September 29

**Native layer installed September 29 at 03:40 IST; Judy's visible jaw test passed.
Speech timing is installed live; the user confirmed speech movement/reset but
rejected the simplistic local articulation.**

The accepted movement checkpoint is `61a703d` (code `68ae15c`). That movement
controller is unchanged. The user closed the game; the installer hash-verified
the native scripts, separate archive and Lua modules, then launched the EXE.
The game's startup redscript compilation completed at 03:40:46 IST. A fresh
Johnny will also use the private combat record from `00ce6b9`.

Spawn a fresh owned Judy, inspect `party-face-state`, and run one five-second
`party-face-probe:judy-alvarez:<nonce>`. Her jaw should open and close twice and
return to the original face. Verify Johnny independently. Do not describe the
layer as working based only on compilation or an accepted feature event.

The fresh Judy and Johnny both report prepared native graphs. The first probe
failed in its diagnostic runner before producing any frame. After replacing
late CET event registration with a temporary delegate on the existing adapter
tick, Judy's five-second probe completed with 24 logged samples and an accepted
native reset. Evidence: `runtime/judy-jaw-probe-20260929.json`. The user then
confirmed **visible mouth movement and return to normal**. This is a jaw-control
proof, not yet speech lip-sync acceptance. Johnny's graph is prepared, but his
visible facial test is still separate.

Full reply lip-sync acceptance remains open. The first driver now connects
Convai frames and local-voice timing to the actual audio cursor, as described below.

## What the running game showed

`runtime/party-face-reflect.json` was read from the two attached, mod-owned
companions without changing their components. Both have a `face_rig` animated
component and 414 tracks, including `jaw_mid_open` and its
`jaw_mid_openLipsyncPoseOutput` input.

| Copy | Native facial graph | Initialized nodes |
| --- | --- | ---: |
| Judy | `player_woman_photomode_sermo.animgraph` | 92 |
| Johnny | `man_average_sermo.animgraph` | 274 |

Neither graph exposes a jaw float input. Both feed a native `animAnimNode_Sermo`
solver. The installed Codeware 1.20.5 exposes component resources and graph
metadata, which allows this read-only inspection.

When using CET, obtain an opaque resource reference through
`ReflectionProp.GetValue(ToVariant(component))` and
`ResourceRef.FromVariant(...)`. Passing `component.rig` directly to
`ResourceRef.GetPath` has the wrong script-reference type; CET's `ToVariant`
also rejects that raw userdata. The final diagnostic uses the typed reflection
route successfully.

## Implementation

- `assets/facial/controls.json` defines nine standard human graphs and 50 mouth,
  cheek, tongue and upper-face controls. It excludes head/neck orientation and
  eye direction controls.
- `Build-FacialGraphs.mjs` reads exact graph exports from the installed game and
  adds a separate `ConvaiFace` feature. Its zero-initialized float inputs add to
  the corresponding `LipsyncPoseOutput` tracks immediately before the existing
  Sermo solver. The original pose input and gaze links remain intact.
- Each result has its own `cyberpunk_convai\facial\...` depot path. The archive
  contains no original game resource paths. Original resources are never edited
  in memory or replaced on disk.
- `Face.reds` preloads those resources. Codeware's `Entity/Initialize` callback
  is filtered by the `CyberpunkConvaiCompanion` dynamic-entity tag, which the
  manager assigns before creation. The callback repeats the ownership check,
  validates the rig's required tracks and the exact source graph, and substitutes
  the prepared graph before native initialization. Unsupported/missing resources
  leave the original face intact and report a status.
- Appearance rebuilds use the `Entity/Extract` builder seam described above;
  readiness validates the actual active component rather than its previous flag.
- `FaceFeature.reds` is generated from the same schema. The native apply/reset
  methods require a prepared, attached, living, tagged companion.
- `face-probe.lua` runs only when requested through diagnostics. It submits two
  smooth jaw pulses over five seconds, then resets the feature. It also cancels
  on a menu, speech, target loss, CET shutdown or its twelve-second deadline.
  It temporarily delegates from the existing speech adapter's idle update loop,
  restores every delegate on completion, and drops IDs without native queries
  on session unload. It never registers another CET update/shutdown callback.
  Only IDs are retained between ticks; it does not retain actor/component handles
  or change movement, gaze, audio or quest actors.

The service stores resource references, not live NPC references. A normal
zero-valued feature is the idle state. The Lua speech adapter owns each utterance
and resets on completion, cancellation, pause and mute. Death/unload drops its
state without querying destroyed components. Live lifecycle and range-loss
checks remain separate from executable unit checks.

## Build and verification

Local tools used:

- WolvenKit Console **9.0.1**, ZIP SHA-256
  `364427384c0f4ebb6b157fa9abd01595258af1b7993c7b3a7edd2920f2016e92`,
  checked against the release asset digest.
- Official portable .NET Runtime **10.0.12**, checked against Microsoft's
  release-metadata SHA-512, under `vendor/dotnet-runtime-10.0.12`. No system-wide
  runtime configuration was changed.

Run from the project:

```powershell
.\scripts\Build-FacialAssets.ps1
.\scripts\Compile-Redscript.ps1
node --test bridge/facial-graphs.test.mjs bridge/companion-behavior.test.mjs bridge/companion-motion.test.mjs
```

Each asset build uses a fresh ignored directory. The builder extracts only the
nine named graphs, writes separate resources, converts them back to the native
format and re-exports them for inspection. Verification requires all 50 controls
to remain connected before the solver with additive operations and the correct
feature declaration. The packed RDAR index must contain exactly the nine allowed
mod paths. Only a successful build is copied to
`runtime/facial-rig/package/convai_facial.archive`.

Current evidence:

- Native redscript compilation passed against installed Codeware, TweakXL,
  Audioware and other installed scripts.
- Nine graph round-trips passed, 50 connected controls each.
- The archive's exact entry set passed verification.
- 46 graph, combat-record and companion checks passed; no skips. The full suite
  has 119 passes, no failures, and one environment-dependent installed-MCM test
  skipped. All 23 Lua modules compile.
- Installed game startup compilation passed; this proves script loading, not
  visible animation. The same install activated the previously staged per-voice
  reverb opt-out in `Speech.reds`.
- Judy's two jaw pulses and return to normal were visually accepted by the user.
  Four diagnostic lifecycle checks also pass. **Dialogue lip-sync acceptance
  remains open.**

Game-derived binaries and JSON exports stay under ignored `runtime/`; tools and
reference repositories stay under ignored `vendor/`. Commit the authored schema,
builder, native service, diagnostics and tests.

## Sources and outstanding work

### Phonetic articulation and phrase playback, September 29

The amplitude-only local face below is now the failure fallback. The installed
local pipeline uses CPU phonetic cues, authored 3D articulation across 17 native
controls, and continuous 60 Hz transitions. Local TTS is prepared in phrases so
the first voice/face segment can play while later segments generate. No new game
startup assets are needed. See [SPEECH_STREAMING.md](SPEECH_STREAMING.md) for the
protocol, measurements, setup, limitations and pending visible validation.

### Speech integration, September 29

The first playback adapter is installed live, without another native restart.
`bridge/blendshape-capture.mjs` preserves each SDK frame and its indexed time;
the earlier collector consumed several frames but saved only the last one at
each browser poll. The mapping explicitly uses SDK 1.7.0's ARKit **61** ordering
(JawOpen index 17). It does not assume the common ARKit-52 ordering.

`bridge/facial-timeline.mjs` produces a bounded 30 Hz timeline of eleven mouth
controls. Convai replies use captured jaw, lip closure, funnel, purse and stretch
weights. The local OmniVoice path uses a read-only PCM amplitude analysis to
drive the three already tested jaw/lip-apart controls. This local fallback is
**not phoneme-accurate lip sync**. Neither route modifies the voice WAV, and
neither supplies head or eye rotation. Silent audio intervals close the mouth.

`mod/facial-playback.lua` validates the request ID, exact copy's entity ID,
duration, timestamps, control whitelist and weights. Only a prepared owned
companion can receive a feature. `speech.lua` samples at Audioware's actual
playback cursor, resets on pause/cancel/end, and discards all facial references
without native calls on world unload. A facial failure leaves the voice and
subtitles available. Unsupported rigs and ambient quest/crowd actors continue
without this facial layer.

Validation: 132 checks passed; the installed-MCM check was skipped. The new checks
include actual SDK queue batches, ARKit ordering, PCM 16/24/32 and float stereo,
silent intervals, unchanged waveform bytes, stale reply rejection, cursor-based
interpolation, pause/resume, switching speakers, muting and world unload.
The user confirmed Judy's mouth moves during the reply and returns to normal,
but called the articulation too simplistic. The timing/cleanup foundation is
accepted; the amplitude-only local face is not the intended finished result.

A real Judy F6 reply used OmniVoice 32 and a 30.4-second timeline of 913 frames.
The game accepted 1,322 interpolated feature applications and returned
`finished`, `restored=true` at the end. This verifies the installed cursor and
reset path, not the visible quality. Receipt:
`runtime/speech-face-judy-20260929.json`. An additional browser collection check
passes: draining ahead-delivered facial data cannot finish a reply while audio
is still playing.

- [Codeware lifecycle documentation](https://github.com/psiberx/cp2077-codeware/wiki#lifecycle)
  identifies Initialize as the stage with an assigned entity ID before component
  initialization; it also documents dynamic-entity tag filters.
- [Codeware resource wrappers](https://github.com/psiberx/cp2077-codeware/blob/main/src/App/Depot/ResourceReference.hpp)
  provided the typed resource inspection route.
- [WolvenKit Console release](https://github.com/WolvenKit/WolvenKit/releases/tag/9.0.1)
  provides the asset conversion/packing tools.
- [Cyberpunk Blender add-on facial solver](https://github.com/WolvenKit/Cyberpunk-Blender-add-on/tree/7a4ee793c36d9615946fe87ec9d42cde7568021d/i_scene_cp77_gltf/animation/facial)
  documents/reconstructs the native track solver and its additive lip-sync pose
  inputs. It informed the investigation; no Blender installation or solver copy
  is required by the mod.

Next: visually validate real speech with local and Convai voices, including the
individual lip-closure/funnel controls and remote stream alignment. Then refine
local articulation and blend restrained expressions/blinking, and verify group
playback, pause/cancel/reload and multiple copies in the game. The existing
OmniVoice 32/16 choice and raw audio quality remain the voice policy.
