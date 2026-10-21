# Native facial animation

> **October 5:** local voices and continuous Convai speech now use a model trained on the game's own JALI dialogue lipsync when local weights exist; see [GAME_LIPSYNC_MODEL.md](GAME_LIPSYNC_MODEL.md). The paths below remain the fallback.

> **October 8: world NPCs, on demand (superseded October 14 by "ordinary NPCs get the face at spawn" below; kept as history, the on-demand rebuild never worked).** The layer is no longer companion-only, but nothing is prepared at spawn (FPS): a running `face_rig` cannot change its graph in place, so when a conversation opens `init.lua` calls `NPCPuppet.ConvaiFaceRequest()` on the talk target. `ConvaiFaceService.RequestWorldFace` checks the running face without writing it, queues the NPC's current appearance name and rebuilds that same appearance (`ScheduleAppearanceChange`). The `Entity/Extract` callback prepares the matching appearance-only rebuild, the same seam that replaced Johnny's face on October 2. `ConvaiFaceReady()` then adopts the world NPC from its running graph path; a dynamic entity still needs the `CyberpunkConvaiCompanion` tag. At most two world NPCs keep the layer; a third request rebuilds the oldest back to vanilla. NPCs in a dialogue, quest-owned NPCs (`q###`, `sq###` or `mq###` in the appearance name or TweakDB record), quest-marked or non-autonomous ones, and scene NPCs that are neither vendor nor crowd are never rebuilt (October 9, after a Konpeki receptionist from `q004` was; on October 10 a scene alone stopped blocking vendors, see [WORLD_COMPANIONS.md](WORLD_COMPANIONS.md)). Measured live later on October 10: the same-name appearance change this relies on is a no-op, so no world NPC is prepared (see [WORLD_COMPANIONS.md](WORLD_COMPANIONS.md)). Every other NPC keeps the vanilla graph. In Lua, speech playback writes to whoever `speech.lua` is voicing (`speaker()`), and idle, thinking and listening faces stay on managed companions (`owns()`). Not yet proven in game: that a same-name appearance change really rebuilds `face_rig`, and that the rebuild is not visible. The vanilla graphs offer no zero-cost alternative: their only script input is the `AnimFeature_FacialReaction` mood preset, and vanilla lip sync comes from authored scene/VO animations. Statements below that the layer is for owned companions only date from before this change.

## October 19: a replaced model, or a look the game or another mod changed after the spawn (branch `fix/face-replaced-model`; built, redscript compiles, NOT seen in the game)

**Report.** A player on 0.2.1: "I've replaced the character's model before, and when I talk to the replaced character, their mouth doesn't move" (voice works). Nobody knew what "replaced" meant, so this section covers every way a face ends up without a speaking graph. Real evidence in hand: `deliverables/player-reports/carloss0666-20261018-141713` (0.2.0), the game's own Judy in her apartment, `Face request: ... status=stale:base\animations\facial\_facial_graphs\woman_average_sermo.animgraph noted=0 claimed=0 reassembled=0 unmatched=0`, four talks in one session. The face was prepared at her spawn, something rebuilt her appearance afterwards, the rebuilt `face_rig` runs the vanilla graph again, `ConvaiFaceReady` (live graph against the prepared one) said no, and the mouth stayed still. The counters were zero by construction: the rebuild claim of 2026-10-17 only existed for characters another mod spawned.

**What the face request ends in** (every word `ConvaiFaceRequest` / `ConvaiFaceStatus` can answer; `mod/facial-playback.lua` `faceStatusReason` gives each a plain sentence in the log, and `bridge/face-replaced-model.test.mjs` fails if a status word has none):

| Status | Meaning | Mouth |
| --- | --- | --- |
| `prepared:<graph>` | the face runs a graph with the speech layer | moves |
| `service-unavailable`, `unavailable` | the redscript half is not loaded; the character is not attached | no |
| `initializing` | our copy was still being built | no (until it finishes) |
| `no-face-rig`, `rig-not-loaded`, `unsupported-rig` | no `face_rig` component; the rig did not load; the rig lacks one of the 59 lip-sync tracks (the first missing one is in the detail) | no |
| `speech-graph-not-loaded` | the game has not loaded the mod's graphs: `convai_facial.archive` is missing, in the wrong folder or not enabled. The detail says `mod-graphs=loaded:0 failed:13` | no, for everyone |
| `unsupported-graph:<path>`, `unprepared:<path>` | the face runs a graph the mod has no copy of (a model another mod replaced with its own graph, or a light-crowd face) | no |
| `stale:<path> noted= claimed= ...` | prepared once, rebuilt since, vanilla graph again | no |
| `skipped:named`, `skipped:no-record` | the spawn rules leave the character to the game (a story character with Talk to story characters off, a record that cannot be read) | no, by design |
| `skipped:quest` | another mod's character that a quest marked (`IsQuest`). A quest token in a game-placed character's record or appearance is no reason any more (2026-10-22) | no, by design |
| `skipped:dialogue`, `skipped:driven` | a game dialogue or a commanded AI refuses the talk-time guard | no, until it ends |
| `screen:<reason>` | the same for an add-on's screen face | no |

**Which "replaced model" does what.**

- *A look changed after the spawn* (the game's quest scripts, or another mod's appearance change on a character in the world, on a character it spawned, or on one of our own copies). The rebuild builds `face_rig` again with the graph its appearance file names, the vanilla one. Before: only a character another mod spawned was prepared again (`OnReassemble`), a game-placed character and our own copies never were (`stale:` with all counters at zero), and our own copy answered "managed", so its log line was empty. Now: all three kinds (`ConvaiFaceService.FaceOwner`: 1 our copy, 2 spawned elsewhere, 3 game-placed) are prepared again, each by the rule it had at its first build: our copy gets its companion graph (`PrepareFaceComponent`), a spawned character the gated crowd copy or the companion graph (`PrepareSpawnedFace`), a game-placed character the story or crowd rules of its spawn, filters included (`PrepareGameFace`, `PrepareCrowdFace`, the same function `OnWorldInitialize` calls). The note-and-claim mechanism itself is unchanged: an entity-less extraction leaves its `face_rig` clones (`NoteRebuild`, at most six, weak), the entity's own `Entity/Reassemble` claims the clones of its template before they initialize.
- *A static replacer* (an archive that replaces meshes or an `.app` file). If it keeps a vanilla face graph and rig, nothing changes and the mouth moves (NCA's Lucy, whose body is the Edgerunners Lucy custom character, installed in the 2026-10-19 live session, reads `prepared:woman_average_sermo`). If its `.app` names its own graph or rig, the status is `unsupported-graph:<path>` or `unsupported-rig`: there is no graph of ours to put on it, and nothing in the vanilla graphs takes a mouth value from a script (docs/ORDINARY_NPC_LIPSYNC_RESEARCH_2026-10-14.md), so there is no lower-quality mouth to fall back to. The log now names the path.
- *The Model browser* spawns our own copy of any character record, so it is the companion path. The game has **12** graphs in `base\animations\facial\_facial_graphs` (listed with WolvenKit 9.0.1 from every archive in `archive\pc\content` and `archive\pc\ep1`: no other `.animgraph` under `base\animations\facial`): the nine we cover, `skinning_template` (not a face), and two we do not, **`man_average_sermo_lc` and `woman_average_sermo_lc`**, the light-crowd variants. A light-crowd record's copy reports `unsupported-graph:...sermo_lc.animgraph`. They are buildable (the same Sermo solver node, the same 129 lip-sync track names and `lipSyncEnvelope`, the same override tracks as the photo-mode graphs the builder already handles), but adding them means `assets/facial/controls.json` (two companion graphs, two crowd copies), a rebuild of `convai_facial.archive` and a new archive for players: not done here, it needs the user's go and the archive pack.

**The log.** One `Face request:` line per talk start (text, voice, group speaker) whose face will not speak, and the `Conversation result` line for a reply whose speaker is not ready, now end with `why=<sentence>` and the facts of `NPCPuppet.ConvaiFaceDetail`: `kind=world|spawned|companion`, `record=`, `appearance=`, `template=` (the entity template path: a replacer's own `.ent` shows here), `graph=`, `rig=`, `tracks=ok|missing:<track>|rig-not-loaded`, `mod-graphs=loaded:N failed:N waiting:N` (13 when the archive is mounted). The status line of a stale face adds `kinds=ours:seen/claimed,spawned:...,game:...` and `events=`: `events=0` means the engine never fired `Entity/Reassemble`, `noted=0` with events above 0 means no rebuild reached the extraction as nameless, `noted` above 0 with `claimed=0` means the template keys differ. The detail is a read at talk start or reply, never per frame.

**Cost.** `NoteRebuild` runs for an entity-less extraction only (the first lines return for a first build), once something to protect exists (`m_watchRebuilds`: our copy built, a spawned character built, a story or crowd NPC prepared). `OnReassemble` ends on one array read when nothing waits. No per-frame work, nothing delayed, no appearance change scheduled.

**What only the game can prove** (the mechanism was never seen live; the note-and-claim of 2026-10-17 had no live result either): that a rebuild of a game-placed or our own character reaches `Entity/Extract` as a nameless, entity-less extraction and `Entity/Reassemble` fires for its entity afterwards, with the clones the entity then receives. If it does not, the status line above says which step, and the next fix is a different seam (nothing in the vanilla graph or a running component can be switched in place). Check: with Talk to story characters on, talk to the game's own Judy in her apartment (the carloss0666 case): `face=true/prepared:woman_average_sermo` and moving lips; a `stale:` line now carries `kinds=` and `events=`.

## October 14: a face on a screen (the Delamain cab's seat-back screens; branch `delamain-face`; built, NOT seen in the game)

**How the game animates Delamain on the cab screens (evidence, from the game files with WolvenKit 9.0.1).** The screens show no
drawn face and no widget animation. A real NPC is filmed: `delamain_taxi.scene` acquires an actor from a spawn set whose entity,
`delamain_holo` (the `delamain.ent` / `delamain.app` appearances), has a `face_rig` with the vanilla `man_average_sermo` face
graph on Delamain's own head rig (`base\characters\main_npc\delamain\h0_001_ma_c__delamain\h0_001_ma_c__delamain_skeleton.rig`).
`delamain_camera.ent` holds an `entRenderToTextureCameraComponent` that renders that NPC into `delamain_rendertexture.dtex`, the
dynamic texture the seat-back screen widgets show. The mouth moves because the scene's dialogue lines play JALI lip sync from
`delamain.anims` on that NPC's face rig (the scene's `scnLipsyncAnimSetSRRef`). So the screen face is driven exactly like any
NPC's face: through its `face_rig` graph.

**What we do.** The NPC's graph is one of the four crowd graphs, so the gated crowd copy (the switch described below) fits it as it
is: nothing new in the archive. While an add-on watches the rig (`ConvaiFaceService.WatchScreenFace`, from `handle:watchFace`; the
Delamain add-on watches while a cab exists), `OnWorldInitialize` gives the NPC that spawns with that rig the gated graph and
remembers its entity ID (`PrepareScreenFace`, checked before the crowd mode and past the named and quest filters, since this one
character is a named story NPC). Its status is `prepared:man_average_sermo`, so it gets that head's ducks (the jaw lift itself only on a graph without `speech_owner`). While the add-on
speaker's line plays, `speech.lua` sends the reply's mouth timeline (re-addressed to the NPC's entity) to `facial-playback.lua`
for that NPC (`speech.faceSource` → `addons.faceActor`, which returns only the watched NPC, attached and `ConvaiFaceReady`), and the
expression layer's scene and autonomy guards skip that one entity (`M.screenEntity`): it is a scene actor by nature. At the end
`reset()` closes the gate and the game's own lip sync owns the face again. Without a watch nothing changes (one array size read per
NPC spawn).

**October 15 live test: the welcome's face stayed still, the later lines moved it** (branch `delamain-welcome-face`). The screen face
works (the talk reply that followed drove entity `9003219ULL` for 268 frames, `speech-state.json`). The welcome is written and voiced
ahead and held (CET log: `Remark ready, held` 01:15:57, hold released 01:15:59 as V sat), and `speech.lua` asked for the screen face
once, when that voice started: at 01:15:57, before V sat, when the scene had not spawned its holocall NPC yet. Nothing asked again, so
the whole welcome played without a face. Fix: `addons.faceActor` answers `nil, true` for a watched face that is not ready; such a reply
asks again every 0.25 s of heard playback and the face joins at the heard position (the playing native phrase's face is started then);
and a held remark can wait for the face when its moment comes (`faceWait`; the cab's welcome waits up to 1.5 s after V sits).
Unproven: how long after V sits the NPC appears (the release log says `face ready after` or `face not ready`).

**What only the game can prove.** That the spawn-set NPC goes through `Entity/Initialize` as an `NPCPuppet` after the cab state
reaches 1 (when the add-on starts the watch), that its rig passes the 59-track check (`screen:unsupported-rig` otherwise), that a
render-to-texture camera keeps evaluating our graph, and that the screen shows the mouth in time with our voice.

## October 14: ordinary NPCs get the face at spawn, behind a switch (branch `npc-lipsync`; built, NOT installed, NOT seen in the game)

Why: the on-demand rebuild never worked (a same-name appearance change is a no-op, see [WORLD_COMPANIONS.md](WORLD_COMPANIONS.md)), and a running `face_rig` cannot change its graph. The only moment the graph can be chosen is the NPC's own spawn. Research and the ranked methods: [ORDINARY_NPC_LIPSYNC_RESEARCH_2026-10-14.md](ORDINARY_NPC_LIPSYNC_RESEARCH_2026-10-14.md), method 1. The user chose to skip the single-vendor proof and build it for every ordinary NPC.

**What the crowd graph is.** Four extra graphs, one per crowd head type (`woman_average_sermo`, `man_average_sermo`, `man_big_sermo`, `man_fat_sermo`), built from the same vanilla graph as the companion copies plus one switch. The solver's input is now an `animAnimNode_Switch` with two inputs. Input 0 is the solver's original input, untouched. Input 1 is the same node with the speech layer in front of it (59 `FloatTrackModifier` nodes for the lip tracks and the `Convai speech owner` nodes). The switch weight is a `MathExpressionFloat` `a > 0` that reads the `speech_owner` `FloatInput`; `blendTime` is 0. It is the shape the game builds itself (Switch nodes 25, 27 and 427 in `woman_average_sermo` have the same "a > 0" and a node as input 0). Nothing writes `speech_owner` for an NPC that is not being voiced, so it stays 0, input 1 is never selected and a quiet face evaluates the vanilla chain plus one switch and one compare. Whether the engine really skips the unselected branch is not proven; the A/B below measures it.

**Who gets it** (`Face.reds`, `ConvaiFaceService.OnWorldInitialize`, one `Entity/Initialize` callback filtered to `NPCPuppet` by Codeware, so nothing else pays for it). In order: the NPC is not one of our companions (they keep the companion path unchanged); `face_rig` carries one of the four crowd graphs; its record is readable (`skipped:no-record` otherwise); it is not a named roster character (`NamedRecords`, generated from `assets/facial/controls.json`'s roster, includes Johnny and Silverhand, whose record also uses `man_average_sermo`: `skipped:named`). A quest token (`q###`, `sq###`, `mq###`) in the appearance name or record is no filter any more (2026-10-22, the Afterlife bouncer: appearance `gang__generic_mb__q005__emmerick`, template `base\quest\tertiary_characters\emmerick.ent`, standing at his post with no scene, mouth still): the graph is inert until the mod voices the character, so a quest actor carries it like a roster character does, and the talk-time guard reads what the game is doing. Then `face.graph` is set to the crowd copy of that graph (`prepared:<graph>`). The callback runs once per NPC spawn, writes the graph on the component at that event (whether that is early enough is the first live check) and does no per-frame work. Game-placed story characters are not touched: they are named records or quest-bound. (Amended 2026-10-18: a named roster record is now prepared at its spawn like a spawned character, whatever its graph, while Settings > Talk to story characters is on, and refused at talk time only for a dialogue or a commanded AI; see [WORLD_CHARACTERS.md](WORLD_CHARACTERS.md). Other quest-bound characters were not touched until 2026-10-22; now they are prepared at spawn too, see above.) The first check is "not a managed dynamic entity" (our companions and copies); a rig that lacks the 59 lipsync tracks is refused once per rig path (`rig-not-loaded`, or a missing-track status).

**When it is used.** `ConvaiFaceReady`, `ConvaiFaceStatus` and `ConvaiFaceRequest` are unchanged for the writer except for `TalkRefusal`: a speaking NPC is refused (`skipped:dialogue`; `skipped:driven` through `IsQuest()` or not `IsOnAutonomousAI()`, unless the character stands at a workspot, `IsActorInWorkspot`: a bouncer, vendor or receptionist at their post is not a scene; `skipped:quest` only for another mod's character a quest marked). For a quest-bound person with no roster profile the Lua side adds V's own scene, quest conversation and call, a fight, an injury and a ride (`mod/world-talk.lua`, `idle`) before the conversation starts, and while the reply plays, and the scene and vendor guards are gone (a scene alone no longer blocks anyone). `mod/facial-playback.lua` writes `speech_owner` through `ownerLevel` (rise .10 s, fall .15 s) while that NPC's reply is heard and `reset()` (a fresh zero `ConvaiFaceFeature`) at the end, which closes the gate. The per-head jaw lift is read from the prepared status (`jawLiftFor`: woman_average q=2, the men q=1.5); since October 15 it only marks the ducks while the graph has `speech_owner` (the gated crowd graphs do), and the jaw itself is lifted only on a graph without it (docs/LIPSYNC_APPLICATION_2026-10-15.md); `mapArkit` and the retarget are unchanged. Idle ticks for a world NPC make no native call and write no frame (tested).

**Archive.** `scripts/Build-FacialAssets.ps1` builds `convai_facial.archive` with 13 entries: the nine companion graphs at their existing depot paths and the four crowd copies at `cyberpunk_convai\facial\crowd\<name>.animgraph`. No base-game path is replaced, so removing the archive returns everything to vanilla. `scripts/Verify-FacialGraphs.mjs` checks the archive path hashes, every graph's structure (the switch, the "a > 0" token data, the input it reads, identity of the shared original node) and a WolvenKit round trip.

**FPS A/B (runtime switch, no extra archives).** One file decides, read once when CET loads (a "Reload all mods" reads it again, and it applies to NPCs that spawn afterwards, so reload the save): `runtime/crowd-face-mode.txt` in the game's `bin\x64\plugins\cyber_engine_tweaks\mods\cyberpunk_convai\runtime` folder, one word.

| Word | Meaning |
| --- | --- |
| `off` | No ordinary NPC is touched: vanilla graphs everywhere (the baseline). |
| `ungated` | Crowd NPCs get the speech layer always evaluated (the cost the switch is meant to remove). |
| `gated` | Shipping behaviour: the switch. A missing file means this and sends nothing. |

Steps (the user does these; no live Convai turns are needed):
1. Install the archive, the Lua files and the reds files (list below) and restart the game once.
2. Put the word `off` in `runtime/crowd-face-mode.txt`. In CET press "Reload all mods". `probe.log` must say `Crowd face mode: requested=off applied=off`.
3. Load the same save and stand at one crowded spot (Kabuki market or Jig-Jig Street), dev mode on, the camera not moving. Let `perf-probe.json` record 120 s. Every row carries `crowdFace`, which says which mode it was taken in.
4. Repeat for `ungated` and for `gated`, edit the file, reload mods, reload the same save. Then run each of the three a second time.
5. Pass: `gated` within noise of `off` (mean FPS under 0.5 below, and no more frames over 25 ms). `ungated` is only for information. If `gated` is not within noise, the switch is not skipping its branch and the fallback is to enable the layer only on NPCs near V (a separate change).
6. Delete the file to go back to the default. If `probe.log` says `applied=nil` or `failed:`, the service call from CET did not work and the file has no effect (the stamp says so, never the requested word).

Install list: `convai_facial.archive` (the new one), `r6/scripts/CyberpunkConvai/FaceFeature.reds` and `Face.reds`, `mod/facial-playback.lua`, `mod/init.lua`, `mod/perf-probe.lua`. A game restart is needed for the archive and the reds; a CET reload is enough for the Lua.

**What only the game can prove.** (1) That `Entity/Initialize` runs before the NPC's face component initializes, so setting `face.graph` there takes effect. (2) That the record ID and appearance name are readable at that moment (otherwise the status is `skipped:no-record` for everyone). (3) That the inactive switch branch costs nothing. (4) The spawn-time cost of about 170 more nodes per face (watch for frames over 25 ms while crowds stream in). (5) That the mouth really moves, a vendor keeps its idle and workspot and nothing pops when the switch opens. (6) That `IsOnAutonomousAI()` is true for vendors. (7) That CET can fetch the service for the mode file (the log line shows it). Headless tests cover the filter logic (transliterated), the callback registration and its absence of per-frame work, the graph structure on the real extracted graphs, the archive contents, the writer's gate behaviour and the mode file.

---

## October 10: speech owns the mouth (the shut mouth that came and went)

**Symptom.** Most replies open the mouth; now and then the jaw and lips stay shut although `speech-state.json`
`face.expressions.lastSpeech` shows a written jaw (Evelyn: 517 frames, 377 open, peak .657; earlier 302 of 431, peak
.612). It happened under a gesture workspot, but one live A/B sealed with no workspot at all, and moving every workspot to
the neutral facial idle (gesture round 5) did not cure it.

**Mechanism (read from the extracted graphs and the solver reconstruction).**

- All nine graphs end in one `animAnimNode_Sermo`. Its input chain is the full pose: the Idle state machine (a looped
  `idle__<emotion>__<sex>` facial clip, 39 such SkAnim clips in `woman_average_sermo`), a `FacialMixerSlot` for streamed
  facial animation (scene, look-at), the `WORKSPOT` graph slot and the emotion state machines. A facial idle is always
  playing; no workspot or scene is needed.
- The Sermo solver (reconstructed in `vendor/reference-cp77-blender/.../facial/solver.py`) takes that pose's control
  tracks as `output`, then runs, in order: envelopes, limits, influences, **`output *= lerp(1, <control>AnimOverrideWeight,
  lipSyncEnvelope)`** (skipped when `lipSyncEnvelope` is 0), **`output = clip(output + <control>LipsyncPoseOutput)`**, then
  the pose blend. Our layer wrote only the `LipsyncPoseOutput` tracks, with `lipSyncEnvelope` at 0 and the override weights at
  their reference value 1, so the idle's value reached the solver at full weight and ours was only added: a jaw of .1 to .65
  against `lips_together_up/dn` held at .7 to 1.0 (and `jaw_mid_close`, `lips_suck_dn`, purse, chin raise) by whatever the
  idle clip is doing at that moment. The idle clips loop, so the seal comes and goes with the clip's phase, which is why
  it is intermittent and why a neutral workspot idle (less closure, not none) only reduced it.
- The game's own dialogue lipsync writes `lipSyncEnvelope` and `<control>AnimOverrideWeight` next to the pose, so the idle
  does not add under its mouth. The gesture agent's suggestion (drive each override weight as 1 minus that control's
  own pose) is not enough: a control whose own pose is 0 at that instant (lips together while a vowel opens the jaw) would
  keep the idle's closure. The weight has to follow whether we are speaking, not each control's own value.
- 86 controls have an override track (jaw 7, lips 48, cheeks 2, nose 2, tongue 16, neck 11); eyes, brows, lids and widen
  have none, so blinks and the upper-face emotions are never touched.

**Change.** `assets/facial/controls.json` gets an `owner` block; `scripts/Build-FacialGraphs.mjs` adds one more
`ConvaiFace` float input, `speech_owner`, and 49 `FloatTrackModifier` nodes before the Sermo solver, all fed by that one
input: `lipSyncEnvelope` **Add** (1 node) and, for the 48 jaw, lip and cheek controls in `owner.faded`,
`<control>AnimOverrideWeight` **Subtract** (the sticky and cut-scene corner tracks, tongue, neck and nose are left alone).
At 0 the graph is exactly the old one (envelope 0 skips the stage). At 1 the idle's jaw, lips and cheeks are zero and our
deltas are the whole mouth. In between the idle is scaled by 1 - owner squared. The build refuses a graph whose solver
lacks any of these tracks (`animSermoTestController` lists them; all nine have the same 86 overrides). `FaceFeature.reds`
(generated) gains `speech_owner`; it is not a rig track, so `RequiredTracks()` is unchanged. `Verify-FacialGraphs.mjs`
checks the 59 deltas, the 49 ownership nodes (Add on the envelope, Subtract on overrides, one shared input) and the 60
inputs after the binary round trip.

`mod/facial-playback.lua` writes `feature.speech_owner` from `applyFeature`: eased from 0 to 1 over .10 s while a reply is
heard (phase `speaking`), scaled by the release ease on a pause or stall, easing back over .15 s once the idle writer has
the face (so the idle's mouth returns smoothly and a gap between Omni phrases barely lets go), and 0 at once while blocked
(combat, scene, native dialogue); a reset that bypasses the idle writer (a speaker without the expression layer) zeroes the
feature. Speaking frames always write it; other phases
write it only to hand it back. It is probed once like the extended controls, so an install without the field keeps the old
behavior. `speech-state.json` `face.expressions.lastSpeech.ownedFrames` counts the frames with the idle mouth fully handed
over (0 with `frames` above 0 means the field or the new archive is missing); `face.ownerFace` says whether the feature has
the field. Cost: one float written per speaking frame and 49 extra float-track nodes in a prepared face graph; no new
per-frame work outside the writer.

**Install.** The archive, `FaceFeature.reds` and the Lua go together: **game restart** (redscript recompiles at launch),
then the Lua is hot. A new archive with an old feature class leaves the input unwritten (no effect); a new feature class
with the old archive writes a field nothing reads.

**Not proven.** The solver's override stage is the Blender add-on's reconstruction, and `Subtract` is read as "track minus
input" (at the endpoints 0 and 1 it also equals the swapped reading). Offline only so far: graph structure, the binary
round trip and the Lua writer. The in-game check after the restart: a reply that used to seal the mouth under a gesture or
an idle clip now opens it, the mouth does not pop at the start or the end of a reply, the neutral face when silent is
unchanged, blinks and emotions still show.

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
