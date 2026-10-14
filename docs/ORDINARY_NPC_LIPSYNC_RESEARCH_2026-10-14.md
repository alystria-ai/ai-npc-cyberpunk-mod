# Lip sync for ordinary NPCs: research (2026-10-14)

Research only: no code, archive or game change was made, and nothing was run in the game. Scope: vendors,
gang members, pedestrians and the other "Talk to ordinary NPCs" archetype characters when they speak through
the mod. Story and quest characters the game places stay untouched. Background: TODO.md "Dropped by the user"
(2026-10-10), the 2026-10-10 entries "vendors had no lip sync" and "the world-NPC face rebuild never worked",
`docs/WORLD_COMPANIONS.md` "Lip sync for vendors and scene NPCs", `docs/FACIAL_ANIMATION.md`.

## Summary

- **Root blocker.** An ordinary NPC's `face_rig` (an `entAnimatedComponent`) runs a vanilla face graph
  (`woman_average_sermo`, `man_average_sermo`, `man_big_sermo` or `man_fat_sermo`). Its Sermo solver already has
  every `<control>LipsyncPoseOutput` track we write, but nothing a script can reach feeds them. The only writer
  of those tracks is the `animAnimNode_FacialMixerSlot`, and only the engine fills it (scene and voice-over
  lipsync clips, look-at blinks). The mod's `ConvaiFace` feature is consumed only by our prepared copy of the
  graph, and a running component's graph cannot be swapped: the same-name appearance change is a measured no-op,
  and a graph write on a live component does nothing. Everything downstream already works for world NPCs (bridge
  timelines, `facial-playback.lua` `speaker()`, the native faces writer, `ConvaiFaceApply`). **The only missing
  piece is the graph on the NPC's face, decided before the face component initializes.**
- **Nothing in the vanilla graph can carry per-frame mouth tracks.** Checked node by node in the extracted
  `woman_average_sermo` (318 nodes): the script-reachable inputs are the `FacialReaction` mood preset, the
  `ActionAnimation` facial phase slots (canned clips from `action_animation_facial.actionanimdb`), look-at,
  bumping, hit, ragdoll, workspot state, and ten head/neck limit variables. No float input reaches a mouth track,
  so a jaw-only or "mouth open while audio plays" fallback has no input either.
- **The FPS cost that got the spawn-time route dropped was never measured.** The prepared graph adds 168 nodes
  (108 `FloatTrackModifier`, 60 `FloatInput`; 318 to 486 on `woman_average_sermo`). These are the cheapest node
  kind and run on animation worker threads, not the main thread, but today they run every frame on every
  prepared face. They can be gated off with one vanilla `animAnimNode_Switch`, so a face that is not speaking
  evaluates one switch and one input more than vanilla.

**Ranked recommendation**

1. **Gated speech graph on ordinary NPCs, assigned at spawn** (re-enable the never-shipped `cca9ec7`
   `Entity/Initialize` swap, restricted to the four crowd graphs and non-quest records, with a new Switch gate in
   the graph). No flash: the swap happens before the first frame. Idle cost: one Switch node per face plus one
   script callback per NPC spawn, never per frame. Effort: about one day (builder change, `Face.reds` filter,
   tests), then two live checks. Variant **1b**: override the four base graphs in the archive instead of
   swapping at spawn (no callback at all, but it changes the asset for every NPC with those graphs, story NPCs
   included, and can conflict with other face-graph mods). Use 1b only if 1a fails live. Variant **1c**: an
   ArchiveXL `.app` patch that replaces `face_rig` in a listed set of ordinary-NPC `.app` files (static and exact,
   but per head type and heavy to verify).
2. **Appearance hop on demand** (another appearance of the template, then back, while the NPC turns to V).
   Zero idle cost and nothing at spawn, but two rebuilds per talk target and a visible outfit flash of at least
   several frames that cannot be hidden reliably. This is what the user already rejected. Keep it only as a
   fallback if route 1 is ruled out.
3. **RED4ext hook on the face solver** (write our tracks into the pose of the one NPC that is talking). Fully
   general, no archive, about zero idle cost (one pointer compare per face evaluation, on worker threads). But it
   breaks the plugin's rule of RTTI only, no hooks and no addresses (`native/core/src/plugin/Main.cpp:10`). It
   needs reverse engineering of the solver and its pose layout, and a bad pointer crashes the game on an
   animation thread. It breaks with every game patch. Weeks of work: research only.

Not viable: the vanilla mood preset (no mouth motion, slow blends), the facial action-animation slots (canned
clips only, and they are tied to the AI action system), feeding the engine's voice-over lipsync (it needs a
pre-authored clip per line), Codeware `ChangeResource` (mesh components only), and swapping in a spawned copy
of the NPC (pop, lost workspot and shop state).

**Cheapest proof step:** a development build of route 1a that prepares exactly one record (a street food
vendor), with the Switch gate. Talk to that vendor: `Conversation result ... face=true/prepared:...` and the
mouth moves. That proves the spawn-time swap works on a world NPC. Then the FPS A/B below decides whether 1a can
cover everyone.

## 1. Why ordinary NPCs cannot take our mouth animation today

### What the face pipeline is

Every human face graph ends in one `animAnimNode_Sermo` solver. Its input is the whole facial pose: the Idle
state machine's looped `idle__<emotion>__<sex>` clip, the `FacialMixerSlot` (streamed scene and voice-over
lipsync, look-at blinks), the `WORKSPOT` graph slot and the reaction states. The solver scales the idle under the
lipsync envelope, then adds each `<control>LipsyncPoseOutput` track (`docs/FACIAL_ANIMATION.md`, October 10
section; the solver reconstruction in `vendor/reference-cp77-blender/.../facial/solver.py`). The game's own
dialogue and bark lipsync are `animAnimation` clips with those same float tracks, one per voice-over line
(`base\localization\en-us\lipsync\<scene>\<actor>.anims`, `docs/GAME_LIPSYNC_MODEL.md:7-20`), streamed into the
mixer slot by the engine.

The mod's route: `scripts/Build-FacialGraphs.mjs:46-110` copies each of nine face graphs and inserts a chain of
`FloatTrackModifier` nodes (Add on the 59 lipsync tracks, plus the `speech_owner` envelope/override nodes) just
before the solver, fed by a new `ConvaiFace` feature (`root.animFeatures`, `forceAllocate: 1`). The copies live at
`cyberpunk_convai\facial\*.animgraph` (`runtime/facial-rig/.../package/convai_facial.archive`, 143 KB).
`Face.reds` assigns that graph to `face_rig.graph` before the component initializes: at `Entity/Initialize` for
tagged companion copies (`Face.reds:23`, `OnCompanionInitialize`), and in `Entity/Extract` for appearance rebuilds
(`Face.reds:29-62`). `ConvaiFaceApply` sends the feature with `AnimationControllerComponent.ApplyFeature`
(`Face.reds:345-349`). A graph that does not declare `ConvaiFace` ignores it, so a vanilla face costs nothing and
does nothing.

### What an ordinary NPC is missing

| Piece | Ordinary NPC | Companion copy |
| --- | --- | --- |
| `face_rig` animated component, 414-track rig with all `LipsyncPoseOutput` tracks | yes | yes |
| Sermo solver with the lipsync add stage | yes | yes |
| `FacialMixerSlot` (engine-fed scene and voice-over lipsync) | yes, but no script or native API feeds it our data | same |
| A graph input that reaches the lipsync tracks (`ConvaiFace` feature and its 59 Add nodes) | **no**: vanilla graph | yes: prepared graph |
| Graph chosen before component init | the game chose the vanilla graph | `Face.reds` chose ours |

So the missing component is precisely the **animgraph input**: the `ConvaiFace` feature entry and the Add nodes in
front of the solver. The rig, tracks and solver are already there.

### Why it cannot be added on demand today (measured)

From TODO.md 2026-10-10 (later) and `docs/WORLD_COMPANIONS.md:132`:

1. `ScheduleAppearanceChange` with the NPC's own appearance name does nothing. No `Entity/Extract` fires and
   `face_rig` keeps `woman_average_sermo`.
2. A different appearance name rebuilds at once (`Entity/Extract` 7 ms later, carrying `face_rig`), but the look
   changes.
3. A second change in the same call is dropped.
4. An unknown name resolves to another appearance, so no same-look alias exists.
5. Writing `face.graph` on the running component from Lua reads back unchanged.

Hence `RequestWorldFace` stops with `unavailable:same-name-rebuild-is-a-noop` (`Face.reds:134`,
`WorldRebuildKeepsLook()` is false at `Face.reds:146`).

Codeware has no way around it. `IComponent.ChangeResource`, `ChangeAppearance` and `LoadAppearance` support only
the mesh component types; an `entAnimatedComponent` is `Unsupported` (Codeware `src/App/Entity/ComponentWrapper.cpp`).
`EntityBuilderWrapper` has no appearance setter (installed `Codeware.Global.reds:42173-42185`), so a rebuild cannot be
redirected back to the same appearance either.

### The vanilla crowd graph has no usable input (checked node by node)

Extracted `runtime/facial-rig/build-66d1cedd.../json/woman_average_sermo.animgraph.json` (vanilla), summarized with a
scratch script:

- **Feature entries (15):** `scene_lookat`, `highLevelState`, `upperBodyState`, `ReloadAction`, `ShootAction`,
  `hit`, `UpdateWorkspot`, `lookAt`, `crowd_locomotion`, `bumping`, `FacialReaction`, `ActionAnimation`,
  `CoverStance`, `NonCombatAim`, `ragdollState`.
- **Inputs actually read:** `FacialReaction.category/idle` (picks the idle state), `ActionAnimation.state/stateDuration`,
  `Eyes/Head/Chest` look-at, `bumping`, `hit`, `highLevelState`, `ragdollState`, `UpdateWorkspot`, and
  `facial.facialKeyWeight` (a weight on three reaction-state additive blends).
- **Graph variables (10, reachable with `AnimationControllerComponent.SetInputFloat`):** only the head and neck
  look limits (`neck_up`, `head_twist_left`, ...).
- **Slots:** 6 `SkAnimSlot` (facial idles), 4 `SkPhaseSlotWithDurationAnim` reading `ActionAnimation` with
  `base\animations\anim_motion_database\action_animation_facial.actionanimdb`, the `FacialMixerSlot` and the
  `WORKSPOT` graph slot.
- **Clips referenced:** 39 idle and reaction clips (`idle__neutral__male`, `idle__anger__male`, `face_idle_melee_attack_*`,
  `blackwall_death_*`, `bump_idle_*`...). None is a talking or mouth-flap clip.

None of these reaches a mouth track as a continuous value. `final.redscripts` has no lipsync call for an NPC (the
dump `vendor/reference-game-scripts`: facial calls are only `TriggerFacialLookAtReaction`, `TriggerFearFacial`,
`ResetFacial` and `SelectFacialEmotion` in `reactionComponent.script:3712-3811`, all through `FacialReaction`).

## 2. Methods

Costs are per frame unless noted. "Idle" means an NPC that is not being voiced by the mod.

### Method 1: gated speech graph on ordinary NPCs from spawn (recommended)

**What.** Two parts:

1. **Gate the speech layer in the graph** (`Build-FacialGraphs.mjs`): one more `FloatInput` (`ConvaiFace.active`,
   or reuse `speech_owner > 0`) drives a vanilla `animAnimNode_Switch` (`numInputs 2`, `blendTime` about 0.1 s)
   placed as the solver's input. Input 0 is the original pose node (exactly vanilla); input 1 is the existing
   modifier chain on top of the same pose node. Evidence that this is idiomatic: the vanilla graph already has 28
   `animAnimNode_Switch` nodes. Several of them are fed exactly this way, a feature's `BoolInput` through a
   `BoolToFloatConverter` into `Switch.weightNode` (nodes 63, 139, 154, 316 in `woman_average_sermo`). And 21 of
   its pose links reference an already defined node, so a shared upstream node is normal. Evidence that inactive inputs are skipped: RED4 graph slots carry a
   `dontDeactivateInput` flag (`animAnimNode_GraphSlot`), so deactivating unselected inputs is the default. That is
   an inference; the FPS A/B below measures it. The writer sets `active` to 1 a frame before the first speech
   frame and back to 0 after the release ease.
2. **Assign the graph at spawn, only to ordinary NPCs** (`Face.reds`): bring back the `OnWorldInitialize` callback
   from `cca9ec7` (`Entity/Initialize`, `EntityTarget.Type(n"NPCPuppet")`), with these filters:
   - not a dynamic entity (other mods' spawns stay theirs);
   - the current graph is one of the four crowd graphs `{man_average, man_big, man_fat, woman_average}_sermo`.
     The `player_*` graphs stay vanilla; Judy's record uses `player_woman_photomode_sermo`
     (`docs/FACIAL_ANIMATION.md`, "What the running game showed").
   - neither the record nor the appearance carries a quest token (`QuestBound`), and the record is not a named
     roster character's record. The graph check alone is not enough: Johnny's record uses `man_average_sermo`.
   - the rig track check is cached per rig path, not repeated per NPC.

   The talk-time guards stay as they are: `skipped:dialogue`, `skipped:quest`, `skipped:driven` and the scene
   guard. So even if a story-placed NPC slipped through the spawn filter, it would only carry an inert, switched-off
   graph that behaves exactly like vanilla and is never written. Remove the `WorldRebuildKeepsLook` stop for these
   NPCs: `ConvaiFaceReady` adopts a face whose running graph path is ours (`ConvaiFaceAdoptWorld`, already written).

**Feasibility.** High. The swap is the same mechanism that works for every companion copy. What is not proven is
whether `Entity/Initialize` fires before component initialization for world (community, crowd, vendor) NPCs as it
does for dynamic ones. Codeware documents Initialize as the stage before component init for all entities, and the
`EntityTarget.Type` filter exists in the installed Codeware (`Codeware.Global.reds:41906-41913`).

**Cost.**
- Per NPC spawn (main thread, once): one script callback. Measured nowhere yet; estimated at tens of
  microseconds with the per-rig cache. Crowd spawns run at a few per second while driving.
- Per frame, idle face: one Switch plus one `FloatInput` more than vanilla, on animation worker threads. The
  feature storage (`forceAllocate`) adds about 60 floats per face.
- Per frame, the voiced NPC: the 168 extra nodes, as on companions today.
- Ungated (today's graph on everyone): 168 cheap nodes per face per frame. Estimated at a few microseconds per face
  on a worker thread. With 30 or more faces in view that is probably well under 1 FPS, but unmeasured; the gate
  removes the question.
- Memory: four graph resources already ship in `convai_facial.archive`; per-instance graph state grows with the
  node count.

**Visual risks.** None at spawn (before the first frame). Scene, bark and voice-over lipsync keep working: the
mixer slot is untouched and the switch passes the vanilla pose through. While voiced, the same behaviour as
companions (`speech_owner` hands the idle's mouth over). A later appearance change on that NPC (rare for crowd NPCs)
builds a vanilla face again; the `Entity/Extract` seam could re-prepare it, or the talk simply falls back to voice
only (`ConvaiFaceReady` is false).

**Compatibility.** Uses our own resource paths and changes nothing on disk. Another mod that also swaps
`face_rig.graph` at Initialize would conflict per NPC (last writer wins); none is known.

**Effort.** About a day of code: the builder gate (about 20 lines plus a test in
`bridge/facial-graphs.test.mjs`), the `Face.reds` callback and filter (the `cca9ec7` diff is 42 lines), the
`active` field in `FaceFeature.reds` and the writer (`mod/facial-playback.lua`, and the native faces fields
`native/core/src/systems/faces`). It needs a game restart (archive and redscript).

**Variant 1b: override the base graphs in the archive.** Ship the four gated graphs at their vanilla paths
(`base\animations\facial\_facial_graphs\*_sermo.animgraph`, about 70 KB) so every NPC loads them with no callback.
- Pro: no spawn callback, and it survives appearance rebuilds.
- Con: it changes the asset for every NPC with those graphs, including story characters (Johnny's record uses
  `man_average_sermo`). It is inert while switched off, but the user's rule is that story characters get nothing. It conflicts with any mod replacing the same files, and it
  must be rebuilt after a game patch changes them.

Use 1b only if 1a fails live (Initialize too late for world NPCs).

**Variant 1c: ArchiveXL `.app` patch.** ArchiveXL resource patching (`resource: patch:` in a `.xl` file) can
replace a named component in chosen `.app` files. An unnamed appearance definition applies to every appearance
in the target, and a match by `name` replaces the whole component. A patch could replace `face_rig` with a copy
whose `graph` is our gated graph, for an explicit list of crowd, vendor and gang `.app` files. Story `.app` files
stay out of the list, so they are untouched.
- Pro: static, no callback, survives appearance rebuilds, and the story exclusion is exact.
- Con: the replacement is the whole component, so the rig, `facialSetup`, animsets and LOD fields would have to
  match each target. That means per-head-type source components, and checking hundreds of `.app` files that a
  generator would have to list.
- ArchiveXL has no handler for `.animgraph`, so the graph itself cannot be patched, only swapped.

This is the most precise static form, but heavier to build and verify than 1a.

### Method 2: on-demand appearance hop (A, then B, then A)

**What.** When a conversation opens, schedule another appearance B of the same template (names from
`EntityBuilderWrapper.GetTemplate().GetResource()` appearances), queue A as pending, and in a later tick schedule A
again. The `Entity/Extract` for A carries `face_rig`, and the existing callback prepares it (`Face.reds:35-39`).

**Feasibility.** Medium. Each step is measured separately (a different name rebuilds and carries `face_rig`; two
changes in one call drop the second), but the full sequence has never been run. Unknowns: whether a community
workspot survives two rebuilds (`workspot=in>out`), whether the shop and interaction survive (they live in the
template, so probably yes), and how long B's meshes take to stream.

**Cost.** Zero at idle and at spawn. Per talk target: two appearance builds, mesh streaming for B (a main-thread
hitch of a few milliseconds, unmeasured), then the prepared graph on one or two NPCs.

**Visual risks.** High. B's outfit and face show for at least several frames (until A's rebuild completes), right
when V looks at the NPC. Hiding it means making the NPC invisible for those frames (a blink-out, also visible),
or doing it while the NPC is off screen, which is not when V talks to them. Turning toward V hides nothing: the face
is in view.

**Effort.** Half a day; most of the code exists (`RequestWorldFace`, the pending queue, `ReleaseOldestWorld`).

### Method 3: RED4ext native write into the face pose

**What.** The plugin (`native/core`) detours the face solver's evaluation (`animAnimNode_Sermo`, or the node in
front of it) or the `FacialMixerSlot`, and for the one face instance belonging to the voiced NPC adds the current
frame's values to the `LipsyncPoseOutput` tracks (and the envelope/override tracks) before solving. The plugin already
receives one frame per face from Lua (`FacesNatives.cpp`); it would keep that frame and write it in the hook.

**Feasibility.** Low to medium, unproven. The RED4ext.SDK has RTTI types for the node classes but no address for
their evaluation functions. You would have to find the virtual slot or a byte pattern, the pose's float-track
layout, and how to map a graph instance to an entity. Hooks run on animation job threads, so data handoff needs
atomics.

**Cost.** Idle: one compare per face evaluation (nanoseconds, worker threads). Voiced: about 60 float writes.

**Risks.** It breaks the plugin's design rule (RTTI only, no hooks, no addresses: `Main.cpp:10`). A wrong offset
crashes the game in an animation job; `rtti::Guard`'s `/EHa` catch does not protect a detour on another thread. It
needs re-verification on every game patch.

**Effort.** Weeks of reverse engineering. Keep it as research; do not schedule it.

A softer native idea, also unproven: build an `animAnimation` with float tracks in memory through RTTI and push it
into the mixer slot the way voice-over lipsync is. No script or RTTI entry point to "play a facial clip on this
entity" is known (see the web findings below), and the animation buffer formats (SIMD and compressed) are not
documented. Same effort class.

### Method 4: cheap approximations (fallbacks)

- **`FacialReaction` mood while talking** (`AnimFeature_FacialReaction {category, idle}`,
  `reactionComponent.script:36-40, 3712-3753`). Script-reachable on every crowd face, cost zero. But it only selects
  an emotion idle (joy 3/5, surprise 3/8, ...) through state transitions with blend times; no clip moves the mouth
  in speech rhythm. Toggling presets per syllable would pop and fight the game's own reaction system
  (`ResetFacial` cooldowns). At most it gives a matching mood, not lip sync. Not worth shipping alone.
- **Facial action animations** (`ActionAnimation` feature into the four `SkPhaseSlotWithDurationAnim` nodes,
  `action_animation_facial.actionanimdb`). This is the one vanilla way to play a clip on any crowd face from game
  code. But the clips come from that database (by the graph's own references, melee attack faces), the feature
  belongs to the AI action system (`ActionAnimationScriptProxy`, `aiBackgroundCombatCommand.script:78-126`) and also
  reaches the body graph. Adding a "talk loop" clip means overriding that shared database and an animset. That gives
  a canned flap, not synced to the audio, at real risk. Not recommended. The database contents are unverified
  (extracting it with WolvenKit is a small local read if ever needed).
- **`FacialReaction` with a replaced idle clip.** Mood-preset clips are looked up by name in shared facial animsets.
  Photo-mode and preset tools are known to replace a named clip with custom content. Swapping one rarely used
  preset clip for a talking loop, and selecting it while audio plays, would give a canned, unsynced flap on any
  crowd face. But it overrides a base-game animset for every NPC that uses that preset, and the preset transitions
  blend slowly. Crude; only worth it if routes 1 to 3 all fail.
- **Jaw-only or a mouth-open blend while audio plays.** No vanilla input reaches the jaw (section 1), so this is
  not possible without a graph change. With method 1 in place, it would only be a lower-quality mode of the same
  feature.
- **Swap in a spawned copy** (the retired adoption machinery: hide the original, spawn a tagged copy with a
  prepared face). Visible pop, the copy loses the workspot, shop and community state, and it changes AI. Not
  acceptable for vendors; poor for pedestrians.
- **Re-initialize the live component** (redscript: write `face.graph`, then `IComponent.Toggle(false/true)`).
  Expected not to rebuild the animation instance (toggling enables or disables update; the graph instance is
  created at component init). A ten-minute probe on one crowd NPC could rule it out. If it surprisingly worked, it
  would give a no-flash on-demand route.

## 3. Comparison

| Method | Mouth quality | Idle FPS cost | Per-talk cost | Visual risk | Story NPCs | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| 1a gated graph at spawn | full (same as companions) | 1 Switch per face (worker thread) + one callback per spawn | none extra | none | untouched (filtered), and inert if one slips through | ~1 day |
| 1b gated graph as base override | full | 1 Switch per face, no callback | none | none | asset changed (inert) | ~1 day |
| 2 appearance hop | full | zero | 2 rebuilds + streaming | outfit flash | untouched | ~0.5 day |
| 3 native solver hook | full | ~zero | ~zero | crash risk | untouched | weeks |
| 4 mood preset | none (mood only) | zero | zero | pops | untouched | hours |
| 4 action anim | canned flap | zero | zero | body coupling | untouched | days |

## 4. Proof plan (exact in-game steps for the user)

Install for every proof: the rebuilt `convai_facial.archive`, `Face.reds` and `FaceFeature.reds` (game restart),
plus `mod/facial-playback.lua` (CET reload). Developer mode on for the logs.

**P1, function (cheapest; route 1a limited to one record).** A development switch makes `OnWorldInitialize`
prepare only the street food vendor record (`npc-food-vendor-male`, the one logged at `9000307ULL` on 2026-10-09).
1. Load a save away from that vendor, then walk to the vendor so it spawns fresh.
2. Talk to the vendor (talk key, one typed line).
3. Expect in probe.log: `Face request: ... status=prepared:man_average_sermo` (or no line, since prepared is not
   logged), then `Conversation result ... face=true/prepared:...`. The mouth moves with the voice and closes at
   the end.
4. Check that the vendor keeps its idle and workspot, the shop opens and trades, and no T-pose or pop happens at any
   point.

If the log shows `face=false` with the graph path still vanilla, Initialize is too late for world NPCs: go to 1b.

**P2, FPS A/B (decides 1a for everyone, and whether the gate is needed).** Three builds of the switch:
off, all ordinary NPCs ungated, all ordinary NPCs gated.
1. Stand at a fixed dense spot (for example Kabuki market or Jig-Jig Street) at a fixed time of day, nobody talking,
   no companion.
2. Run 120 s per build with `perf-probe.json` (two-second windows: fps mean, frame time, worst frame), reloading
   the same save each time so the crowd respawns under the build. Run each build twice.
3. Pass: gated is within noise of off (under 0.5 FPS mean difference, no change in frames over 25 ms). Ungated
   tells us what the gate buys.

**P3, story safety.** With the gated build, walk past a quest giver who uses a crowd head (any fixer's contact
NPC) and play a scene with lipsync. Expect a normal scene mouth, and `ConvaiFaceStatus` on that NPC showing
not prepared (filtered) or prepared but never written.

**P4 (optional, ten minutes): the live re-init probe.** On one crowd NPC, write `face.graph` and toggle the
component, then run the face probe's jaw pulses. A visible jaw pulse means an on-demand, no-flash route exists.

## 5. Web and source findings

This section comes from read-only research in the RED4ext.SDK headers, the NativeDB class dump, the Codeware and
ArchiveXL sources and wiki, and public mod sources. "Inferred" means not verified.

- **No runtime lipsync API exists.** The SDK has lipsync types only for scenes and the `.lipmap`:
  `scnActorDef.lipsyncAnimSet`, `scnDialogLine.male/femaleLipsyncAnimationName`, and
  `animLipsyncMapping { languageCodeName, scenePaths, sceneEntries {actorVoiceTags, animSets} }`. Lipsync is
  pre-baked JALI animation looked up by voice tag and locale. Gameplay VO goes through entity events
  (`entGameplayVOEvent`, `entTriggerVOEvent`, `VoicePlayEvent`). Nothing in the SDK, WolvenKit or Codeware plays a
  facial or lipsync clip on an entity from script or RTTI.
- **`AnimationControllerComponent`** script surface: `ApplyFeature`, `PushEvent`, `SetInputFloat/Int/Bool/Vector/Quaternion`,
  `SetAnimWrapperWeight`, `SetUsesSleepMode`, `PreloadAnimations`, `GetAnimationDuration`. None of them plays an animation
  by name. `SetInputFloat` sends an `entAnimInputSetterFloat` event keyed by variable name. The vanilla crowd face
  graph's only variables are head and neck limits (section 1), so it cannot reach the mouth.
- **`animAnimFeaturePlaySlotAnim`** (`slotName`, `animationName`, blend and loop fields) exists, but the crowd face
  graph declares no such feature (its 15 feature entries are listed in section 1), so it has no consumer there.
- **`entAnimParamsEvent.PushParameterValue` / `entAnimatedComponent.animParameters`
  (`entAnimTrackParameter {animTrackName, parameterName, defaultValue}`)** looked like a way to push a float into a
  track. In the game scripts it is used the other way, anim to gameplay: `aiComponent.script:1179` reads
  `rightArmLookAtStatus` from it, and `weakspot.script:513-516` pushes a mesh-hide parameter. No evidence it can write
  a pose track; low odds.
- **The graph is chosen in `entAnimatedComponent::InitializeAnimations`.** ArchiveXL hooks it to append animsets
  (`animations:` extension), which confirms graph and animset setup happen once at component init. No public code
  re-initializes a graph at runtime or hooks pose evaluation.
- **ArchiveXL resource patching** supports `.ent`, `.app`, `.mesh` and a few others, not `.animgraph`. An `.app` patch
  replaces a component matched by name (variant 1c).
- **Codeware**: lifecycle events `Entity/Extract`, `Assemble`, `Initialize`, `Reassemble`, `Attach`, `Detach`,
  `Component/Toggle`. `AddComponent` is meant for assembly time. `ChangeResource`/`LoadAppearance` cover mesh
  components only.
- **Workspots** carry facial idles (`animAnimNode_WorkspotHub.facialIdleMale/FemaleAnimation`,
  `animAnimEvent_WorkspotPlayFacialAnim.facialAnimName`). That is how vendors' faces get workspot idles, but they
  are named clips, not per-frame data, and starting a second workspot on an NPC already in one is unverified.
- **Existing mods**: the only runtime facial control on arbitrary NPCs found is applying `AnimFeature_FacialReaction`
  (a preset and mood change, after `ResetFacial(0)`). Voice-replacement mods rebuild the `.lipmap` for pre-baked
  lines only. No mod lip-syncs arbitrary NPCs with runtime audio.

## Sources

- Repo: `r6/scripts/CyberpunkConvai/Face.reds`, `FaceFeature.reds`, `scripts/Build-FacialGraphs.mjs`,
  `mod/facial-playback.lua:63-80`, `mod/init.lua:1609-1615`, `native/core/src/systems/faces/FacesGame.cpp`,
  `native/core/src/plugin/Main.cpp:10`, commit `cca9ec7` (spawn-time swap, never shipped), TODO.md 2026-10-08,
  2026-10-10 entries, `docs/WORLD_COMPANIONS.md:118-136`, `docs/FACIAL_ANIMATION.md`, `docs/COMPANION_EXPRESSIONS.md:225-240, 330-365, 720-730`,
  `docs/GAME_LIPSYNC_MODEL.md:1-37`, `docs/PERFORMANCE_NATIVE_PLAN.md:74-76` (perf probe).
- Extracted graphs (local, not in git): `runtime/facial-rig/build-66d1cedd3e114c58969ae52dcd0438f3/json/*.animgraph.json`
  (vanilla) and `extended-json/` (prepared).
- Game script dump: `vendor/reference-game-scripts/scripts/core/components/animationControllerComponent.script`
  (`SetInputFloat`, `ApplyFeature`, `PushEvent`), `.../reactionComponent.script`, `.../aiBackgroundCombatCommand.script`.
- Installed Codeware scripts: `red4ext/plugins/Codeware/Scripts/Codeware.Global.reds` (EntityBuilderWrapper,
  EntityTarget, IComponent.ChangeResource). Codeware source `src/App/Entity/ComponentWrapper.cpp` (mesh-only resource change).
- Web (read only): RED4ext.SDK headers (`ent/AnimInputSetter.hpp`, `anim/AnimFeaturePlaySlotAnim.hpp`, `scn*`, `animLipsyncMapping`,
  `animAnimNode_Sermo`, `animAnimNode_FloatTrackModifier`, `entAnimatedComponent`), nativedb.red4ext.com class dump, ArchiveXL
  `src/App/Extensions/ResourcePatch` and `Animation`, the redmodding wiki pages on ArchiveXL resource patching and workspots,
  Codeware wiki (lifecycle events).
