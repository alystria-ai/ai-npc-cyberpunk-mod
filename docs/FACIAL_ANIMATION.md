# Native facial animation

## Current status — September 29

**Installed September 29 at 03:40 IST; Judy's visible jaw test passed.**

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

Full reply lip sync remains open: the native control test must pass before
connecting Convai frames and local-voice timing to the actual audio cursor.

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
zero-valued feature is the idle state. Before production speech uses the layer,
add utterance ownership and reset on completion, cancellation, pause, range loss,
mute, death and reload, without querying destroyed components during unload.

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

After the jaw proof: validate individual lip-closure/funnel controls, map the
actual Convai frame ordering, preserve frame timing against native audio position,
and add a bounded local-voice timing fallback without processing the voice audio.
Then blend restrained expressions and blinking and verify private/group playback,
pause/cancel/reload and multiple copies in the game. The existing OmniVoice 32/16
choice and raw audio quality remain the voice policy.
