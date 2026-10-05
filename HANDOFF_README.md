# Cyberpunk Convai — complete development handoff

**Prepared October 5, 2026, on the user's explicit request to stop work and hand the project to another AI agent.**

This is the entry point for the next agent. It explains the product, development history, accepted decisions, architecture, testing methods, current files, outstanding defects, and voice-training lineage. It is a development handoff, not a claim that every feature is finished or a portable release exists.

## 1. Stop state — read this before doing anything

**Work is paused. Do not automatically restart services, the game, training, agents, or scheduled tasks merely because you read this file. Wait for the user to resume work.**

At the handoff:

- All child agents were completed or interrupted. No child agent remains responsible for an active continuation.
- The task-owned Convai reply bridge and its resident Python voice processes were stopped: PIDs 22256, 3648 and 7288. A subsequent process check found no matching bridge, resident-voice, or teacher-monitor process.
- The temporary installed Blue Moon clearance probe was restored to its prior file. Its SHA-256 is `e13acc13aea1c741d6a41650d1fe11c64e4893dbf97b0f6b4e18019e67c3c9f1`.
- Its last read-only result was preserved at `runtime/blue-backstep-result-20261005.json`. No movement was commanded by that probe.
- The user stopped the latest Kaggle teacher. At **2026-10-04 22:30:42 UTC / October 5 04:00:42 IST**, the API confirmed **CANCEL_ACKNOWLEDGED** for kernel **137093247, version 1**.
- That final API read returned no output files, a `[]` log tail, and no verified startup or optimizer progress. A preceding bounded live-log read timed out. A receipt timestamp alone does not prove training or checkpoint creation.
- No new student distillation was launched from this final expanded teacher attempt. The previously accepted models remain available and configured.
- The game and user-owned windows were not closed as part of this pause. Installed Lua may still run while the game remains open, but our bridge and diagnostic work are stopped.
- There is no new automatic continuation or heartbeat. The user previously asked to delete the scheduled continuation; do not recreate it.

The current cloud run is therefore **cancelled, not a teacher waiting to be selected**. Before any future restart, inspect retained remote artifacts rather than assuming either that a new checkpoint exists or that every remote artifact is absent. The status endpoint's empty output list is not a listing of the private Hugging Face bucket.

### Workspace and installed game

```text
Project:
C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod

Installed CET mod:
E:\SteamLibrary\steamapps\common\Cyberpunk 2077\bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai

Installed game's main directory:
E:\SteamLibrary\steamapps\common\Cyberpunk 2077
```

This is Windows/PowerShell. Use native paths. Keep helper processes hidden.

### Files that must not be touched

- **Do not read, execute, edit, delete, or stage `scripts/Test-GameInput.ps1`.** It is an unrelated, protected untracked file.
- **Do not edit or stage `mod/diagnostics.lua`.** It contains unrelated dirty changes. Do not accidentally install it with a broad copy.
- Preserve unrelated working-tree edits, original recordings, frozen datasets, accepted models, private account mappings, and player histories.
- Do not print credentials or commit generated credential-bearing notebooks. No push, publication, release, deployment, or messages to people are authorized by this handoff.

## 2. What the mod is

Cyberpunk Convai adds AI conversations and travelling companions to **Cyberpunk 2077 2.31 on Windows x64**. It integrates with the game's native phone, subtitles, character animation, combat, navigation, vehicles, and Mod Configuration Menu (MCM).

The user can invite named characters, including characters outside the vanilla phone catalog, talk privately or in a group, send phone messages, and ask a companion to drive. Convai provides dialogue, character configuration, memory, and optional cloud speech. Local Pocket TTS and OmniVoice provide cloned speech using original game references. A native facial layer animates the actual in-game NPC.

This is a working development integration, not yet a clean distributable mod. It has substantial accepted gameplay behavior, but following currently has unresolved regressions and several wider integration paths need native acceptance.

### Main capabilities

| Area | Implementation and current boundary |
|---|---|
| Companion Manager | Native MCM pages: Characters, Current party, Model browser, Settings and nested settings pages. Up to eight copies, including pending invitations. |
| Character catalog | 79 conversation profiles: 77 named characters and two ambient templates. A model and a conversation identity are separate. |
| Invitations | Invite immediately reserves a slot and prepares memory configuration, voice and connection. A talking actor appears only after preparation succeeds and gameplay resumes. |
| Phone | Dedicated Chat tab beside Messages and Contacts; direct contact-to-chat navigation, bottom composer, separate persistent histories/drafts. |
| Private/group dialogue | User-selected CET bindings; addressed person speaks first; group response includes up to three distinct character identities. Duplicate copies do not multiply speakers. |
| Voices | Pocket TTS default, OmniVoice 16, OmniVoice 32, Convai, in that order. Missing prepared local references use configured Convai voices. |
| Facial animation | Native jaw/lip controls, calibrated shared shape mapping, smoothed local animation, actual playback-clock alignment. Native blinking retained. |
| Subtitles | Native Dialogue HUD default; optional overhead captions. Vehicle conversations use the Dialogue HUD. |
| Memory | One persistent player ID across characters, channels and saves. Explicit Forget selected/all clears matching provider memory and successful local Chat history/drafts. |
| Knowledge | Researched public lore and character styling plus selectively verified native quest/save context. Unobserved choices must remain unknown. |
| Relationships | Judy, Panam, River, Kerry and Meredith each have ordinary/alternate profiles with Auto/On/Off. No quest writes. |
| Reactions | Combat opening/end and collected-loot comments, independent cooldowns, shared speech ownership, sequential playback. Exploration remains off/skipped. |
| World behavior | Following, attention, combat, holstering, collision-aware spawning, vehicle passenger behavior, chauffeur action. Current follow defects remain open. |
| Wider transport | Overflow carpooling and fast-travel recovery have implementations but need broader gameplay qualification. |
| Localization | Ten interface languages. Interface translation does not imply multilingual cloned speech. |

The root [README](README.md) is player-oriented. This handoff is for development. Older README/TODO/research passages can describe earlier states; use the chronology and evidence below to resolve conflicts.

## 3. Product decisions that must survive the handoff

### Interaction and UI

- Shortcut keys belong to the player's CET bindings. F4/F6/F7/F8/F9 in historical conversations refer to the user's assignments; never force those keys or assume they are configured.
- The current settings flow has **no Apply button**. Do not tell the user to click one. Some internal voice-selection code still distinguishes preview/saved settings; that does not establish an Apply button in the UI.
- Labels use default red, controls can use cyan, and headings use the native white text/cyan line. Avoid extra indentation and custom purple labels.
- Keep Back controls on nested pages. Do not repeat the entire top-level navigation or Your group section on every page. Group count belongs on Current party.
- Esc from the manager returns directly to gameplay. This was accepted after a specific fix.
- Phone Chat hints and world-chat hints differ. Phone input contains the Enter/Esc guidance; world chat retains the original “Type your message to the character.” prompt.
- Avoid speculative UI work. Layout, fonts, Japanese glyphs, typing, contact spacing, histories and navigation have already received repeated user acceptance.

### Companions and conversations

- Camera rotation alone must not rotate or reform the group. Walking around to face a nearby companion should not make everyone move.
- Do not make an NPC step back merely because V approaches their face.
- Latest follow requirement: when V really **runs and moves a modest distance**, followers should depart earlier. Preserve small conversational repositioning while walking.
- No automatic companion restoration on save load, death, game restart or CET reload. Fast travel is the separate recovery case.
- Follow-up questions default **Off**. When enabled, they should be relevant; only the final group speaker asks. Automatic reactions do not ask questions.
- Use three separate Convai fields for background, speaking direction and sample dialogue. Examples contain spoken words, not `CharacterName:` prefixes.
- Characters should have back-and-forth conversations, selective disclosure and personality. Asking Johnny about the war should not automatically produce a biography dump.
- Memory preparation does not mean manufacturing a conversation. Do not send memory-seeding calls for unused characters.
- Routine driving/preparation blue popups are Developer-mode-only. Important actionable errors remain visible. Failed invitations should report once and wait for explicit retry/cancellation.

### Speech and training

- Preserve source speech quality; do not add gratuitous EQ, pitch changes, denoising or crossfades.
- Convai speech has its own continuous streaming route. Do not split its dialogue into local-TTS phrase requests.
- Pocket receives complete reply text once and streams PCM. Omni uses phrase scheduling because its public generation returns completed waveform arrays.
- One shared model plus per-character acoustic references; no separate model/LoRA per character in the current plan.
- Keep accepted models installed until a replacement is actually qualified. Teacher training is not permission to replace the runtime student.
- User selected standard **A** after the A/B/C work. Do not restart the conditioning/speaker-marker debate or substitute B/C without a reason and evidence.
- Maximum **three rotating checkpoints** for the full training run. They must be accessible during the run and old slots overwritten rather than accumulating versions forever.
- User authorized GPU usage regardless of the old `gpu use.txt`. For interactive benchmarking, record power profile and game load; Silent versus Balanced materially changed previous results.

### Scope and working style

- Keep local Git checkpoints and feature documentation current. The former TODO/PAUSED notes were consolidated into this handoff; any future scratch TODO/PAUSED files remain ignored by Git.
- The user explicitly asked to reduce testing. Use focused causal checks and existing logs; do not keep requesting the same drive/follow sequence.
- Helpers must be hidden. Do not open visible shells or accidentally focus the user's desktop.
- Subagents, when authorized, should inherit the current parent model/reasoning. The user changed explicit model preferences several times; the latest durable request was inheritance, not a hardcoded older model.
- Packaging was paused while voice integration/model work continued. No portable release has been qualified.

## 4. Development history

This summarizes the substantive history, including rejected directions and regressions. It is not a verbatim transcript. Git and the linked evidence preserve finer implementation detail.

### Phase A — basic conversation, native phone and local rollback

The original problem was a character not responding to a greeting and uncertain lip-sync support. The updated Dawnwalker reference mod supplied ideas for expression, gaze, reactions, group follow-ups, interface languages and battle context. The user later emphasized that Cyberpunk should retain its own natural UI and speech behavior rather than copying Dawnwalker mechanically.

The phone's invite/dismiss shortcuts initially leaked through to the journal. Input consumption was fixed, with normal journal behavior restored after closing the phone. Confirmation was moved into the visible phone experience. Convai credentials were stored in an ignored project file, and the reply bridge established profile/configuration routing.

Replies first used notifications. The user requested native subtitles and no thinking notification. The native subtitle widget was integrated; one apparent failure was the game's disabled dialogue subtitles. Mixed-case input required correcting a native text-widget capitalization setting. Private and group text input were then separated; addressed-first group order and per-copy routing followed.

The user requested local Git rollback throughout development. Many later changes have focused commits rather than one final unreviewable patch.

### Phase B — voices, streaming and facial control

Native positional playback was introduced, initially with Kokoro/Convai paths. Microphone interaction was prepared, but the user deferred the live mic test. Group voice playback worked, although the user disliked two voices and asked to keep audio close to source.

The user suggested VoiceStudio. It was investigated as a wrapper around other models, not a novel speech architecture. Tests included Chatterbox variants, OmniVoice 16/32 and VoxCPM2. Original Johnny, Judy and Panam dialogue was used for comparison. Omni32 was preferred; VoxCPM2 had awkward pacing/gaps and severe live resource impact in one experiment. Cold/warm measurements under Cyberpunk RT Ultra and a 60 FPS cap were repeated after crashes/movement/profile changes; interrupted trials were not presented as clean results.

An early Judy Omni fine-tuning/LoRA pilot sounded worse than base. It was rejected. The user chose shared Omni references instead, first for Johnny/Judy/Panam and later for the larger cast. A shared reference-conditioned model was preferable to a full network per character. Omni16/32 became user choices with warm residency.

Initial local lip sync was mostly a jaw envelope and looked like a wooden puppet. Native game facial graphs/controls, Convai facial data, phonetic shapes, closure and upper-lip controls were investigated. Playback clock and source admission defects were fixed. Stronger, varied lip shapes and smoother transfer improved the result; excessive right-upper-lip distortion and insufficient opening were corrected. The user eventually accepted the mapping as good enough and asked to move on. The mapping applies across local engines, but Pocket needed its own timing/envelope adaptation and later resident acoustic-phone analysis.

Convai audio initially inherited unnecessary chunk/stitch behavior. The user correctly challenged that. The cloud path was separated from Omni phrase generation and changed to continuous streaming; tiny gaps disappeared. A later silent check was caused by Dialogue Volume at zero, while separate clock/facial-source bugs were also fixed. Do not reintroduce full-file waiting or text splitting for Convai.

### Phase C — native manager, phone Chat, identity and settings

A simple manager was rejected in favor of a full native settings-style page. MCM integration was added. Shortcut entry initially stopped at the pause menu; it was fixed. A later styling callback exhausted CET's tiny remaining callback allocation and crashed; styling was moved out of that callback. Correct red labels/indentation were accepted, followed by Esc-to-gameplay acceptance.

The phone initially reused vanilla message-thread navigation and placed the composer too high. A separate Chat tab was built, with direct contact selection and a bottom composer. Gold scripted suggestions were removed, tab styles connected, and cyan input hints corrected. Vanilla SMS appeared across AI chat windows, then histories were shared accidentally; isolation was corrected and user-confirmed.

Several memory designs were considered. A native save-identity component caused startup trouble and was removed; the game then loaded normally. The user explicitly simplified the design to one player ID across all saves and characters, with manual character/all reset. Disappearing messages and three-save timeline schemes are obsolete. The Memory submenu and reset-to-local-history behavior were implemented.

Invitation preparation was moved to the instant Invite is selected, before the actor appears. Connection warm-up and voice preparation are included. Hanako's repeated preparation errors were latched to one attempt/error; updated handling preserved the original cause. The user later confirmed Hanako joins.

### Phase D — character behavior, combat, reactions and knowledge

Johnny originally spawned invisibly or on an inappropriate floor. His ghost controller/solid appearance, native spawn placement and combat configuration were corrected. He then fought with his pistol. Kerry's spawn was changed to a clothed appearance (`e2d9222`). Iris/Judy exposed following and attention problems: moonwalking, unwanted direction matching, and group repositioning when V merely looked around. A movement controller with explicit social/travel ownership replaced successive ad hoc turns.

Several following states were accepted in normal play, but later car-exit and long-distance cases regressed. Do not read earlier “accepted” entries as proof that current following is complete. The exact current state is in section 7.

Combat start/end comments initially failed because old Lua was still active or playback state was cancelled incorrectly. After actual CET reload and fixes, both comments were heard. Loot capture was qualified using a deliberately placed two-drink bag; storage provenance was checked independently. Basic loot comments were heard. Judy's weapon remained drawn after combat because a remembered impact/location could keep the combat state alive; actual combat and holster behavior were then accepted.

Exploration dialogue capture was too difficult for the user to trigger reliably and was explicitly deprioritized. It remains off/skipped. Combat and loot comments should stay separate, queued in order.

Convai character creation originally packed background/style/examples together. The user supplied the correct three-field request shape, and all profiles were corrected. Name prefixes in examples caused spoken names; they were removed globally. Follow-ups were verified with a relevant question and no name prefix.

Lore collection expanded into source-attributed character profiles and native quest-state mapping. The user particularly requested Johnny, Panam, Judy, Jackie, Reed, Songbird, Takemura and Rogue. Their reviewed source integration is complete; natural recall of every branch is not. The current pack is 394 rules / 382 mapped outcomes out of 1,162 researched outcomes, leaving 780 unmapped. Do not confuse a scraped branch with a reliable current-save predicate.

### Phase E — vehicles, chauffeur, collisions and subtitles

Passenger boarding was confirmed. Seated eye contact initially turned the torso and stretched a hand anchored to the knee; head-only seated attention fixed the arm pose. The user requested a natural “drive for me” action rather than a manager-only waypoint button.

Chauffeur work progressed through action routing, owned-car selection, driver-seat command ownership, manual player boarding, native NPC driving, waypoint changes and arrival cleanup. Native driving now follows changed destinations. The vanilla Johnny apparition overlapped the summoned driver; a guard/solid appearance fix was installed and user-confirmed. A restored owned Porsche can be selected after loading a save without summoning it again (`c2b5a78`).

False destination-change cancellation and repeated popups were corrected. Arrival can clear a native waypoint; that is not automatically a user cancellation. A trip can stop short of an unreachable exact marker. Subsequent walking was accepted in some cases but later stop/run and first-departure failures remain part of the current follow investigation.

Overhead captions once moved/flickered and later disappeared. Projection corrections restored them. Boarding must not replay an already shown overhead sentence as cinematic text; the installed transition fix keeps the unread frontier. That particular visual acceptance is still outstanding.

Collision-aware spawning and walking were added after actors appeared inside props/cars. The current collision checks are intentionally retained; do not disable them to make a blocked actor move. Overflow fleet/car pooling and fast-travel lifecycle source exists, with wider native checks outstanding.

### Phase F — Pocket TTS, cast training and data expansion

Pocket TTS was investigated for CPU speech. Stock short references sounded weaker, while a 22-second Johnny montage improved pacing. The larger official teacher sounded better than the small student. The user authorized Kaggle GPU training, then asked to concentrate on a small runtime student rather than shipping the teacher.

Teacher adaptation and student distillation produced an accepted six-layer EMA1500 student. Johnny/Judy/Panam examples were approved; the user requested Pocket replace the default Omni option. Omni was later restored as an explicit choice, yielding today's four-option selector. Production inference was audited against sample generation, including exact reference bytes, copied speaker state, decoder settings and end-of-speech handling.

Evelyn, Jackie and other thinner characters sounded weaker. The user asked for substantially more genuine game dialogue across the cast, balanced contribution, and explicit tiers. Native speaker/caption associations, mismatched audio banks, local STT, alignment, source attribution and actual codec qualification were investigated. There were real data mistakes; do not assume all text-to-audio bank joins are correct just because the game assets themselves are authentic.

The final corpus now has 8,140 training clips across 79 identities. A/B/C conditioning experiments, Tier1 tables, objective comparisons and a blind listening tool were completed. The user selected standard A. They want a patient, substantial teacher continuation followed by student distillation, not more student-only refinement against an unchanged teacher.

### Phase G — training observability and current pause

The first full teacher showed RUNNING for roughly twelve hours without accessible logs or models. Cancellation yielded no verified progress; its quota reservation returned. This was not treated as twelve hours of successful training.

A 100-update observable probe then proved startup/loss/epoch/save reporting and retrieval of an actual step1 model while the job was still running. Full training was adapted to export private remote checkpoints. The user requested at most three checkpoints, so append-only Git-backed retention was replaced with a private bucket and rotating slots.

The first rolling full run failed before optimizer updates because one Judy source recording is 32.5128 seconds, over a 30-second preparation admission guard. Its actual aligned training target is only 13.5055 seconds. A minimal 33-second source-window override retained the unchanged 30-second target limit and frozen corpus. The corrected replacement was submitted once, then cancelled at this handoff. No final expanded teacher or new student is yet qualified.

## 5. Architecture and source map

### Runtime layers

```text
Native phone/MCM/CET binding
    -> Lua interaction + exact actor/turn ownership
    -> local bridge IPC
    -> Convai dialogue / memory / actions / optional voice
    -> selected speech route
         Convai: continuous cloud PCM + supplied facial stream
         Pocket: full text -> warm CPU student -> incremental PCM
         Omni: scheduled stable phrases -> warm CUDA model
    -> continuous/native audio playback + playback clock
    -> native subtitles + Lua/native facial application
```

The bridge, model, cached acoustic reference, conversation profile, spawned actor and player ID are different resources. Their ownership/version identities must not be conflated.

### Lua and native components

| File/folder | Responsibility |
|---|---|
| `mod/init.lua` | CET lifecycle, polling, native hooks, IPC, manager and reaction integration. |
| `mod/companions.lua` | Party roster, actor lifecycle, measured snapshots and group update ownership. |
| `mod/companion-behavior.lua` | Social/travel state decisions. |
| `mod/companion-travel.lua` | Real displacement/travel intent versus local conversational motion. Contains an uninstalled edit at pause. |
| `mod/companion-actuator.lua` | Owned native movement commands, route admission, execution, recovery and look ownership. |
| `mod/companion-clearance.lua` | Body/swept collision checks and bounded query accounting. |
| `mod/companion-space.lua` | Lanes, geometry and social spacing. |
| `mod/companion-locomotion.lua` | Native MoveTo observation and stale-facing cleanup for exact owned commands. |
| `mod/companion-vehicles.lua` | Seats, chauffeur/fleet lifecycle and exit ownership; see adjacent vehicle adapters/catalog. |
| `mod/movement-log.lua` | Bounded persistent Developer-mode movement capture. |
| `mod/facial-playback.lua` | Facial playback integration; inspect adjacent audio/subtitle modules for full route. |
| `r6/scripts/CyberpunkConvai/` | Native redscript UI and integration. |
| `bridge/` | Node dialogue/runtime orchestration, provider adapters, workers, speech/facial streaming and tests. |
| `characters/`, `research/cyberpunk/` | Profile sources and attributed knowledge/native mapping artifacts. |
| `scripts/` | Build/install/diagnostic/data/training tools. Inspect individual tools; do not run everything. |
| `vendor/`, `runtime/` | Ignored dependencies, private configuration, generated assets, logs, datasets and models. |

The exact source/native APIs are available in `vendor/reference-game-scripts`, pinned to `fce9ab7e6a608b0d729290d898003589515900e1`. A fresh clone will not contain ignored generated dependencies and game-derived assets.

### Installed frameworks recorded in the README

CET 1.37.1, RED4ext 1.30.0, redscript 0.5.31, Codeware 1.20.5, TweakXL 1.11.4, Audioware 1.9.9 and MCM 0.10.3. Treat these as the development inventory, not a recommendation to upgrade them blindly.

### Starting the bridge after the user resumes

`scripts/Start-ConversationBridge.ps1` checks for an existing process, builds the voice client, and starts the Node bridge hidden. Its default key is `runtime/convai-key.txt`. The default state directory is `runtime`, overridable by its parameter/environment. Read the script before use; do not start it during this pause.

The log files are `runtime/bridge.stdout.log` and `runtime/bridge.stderr.log`. Existing logs/configs may contain private conversation material. Do not paste them wholesale into public artifacts.

## 6. How we develop and verify this mod

### Evidence levels

Keep these separate in every status report:

1. Source implementation/review.
2. Focused fixture or compiler result.
3. Installed bytes and active reload version.
4. Actual game state, rendered motion, audible playback or user acceptance.

Passing 100 tests does not prove an NPC walks naturally. A successful redscript build does not prove a widget appears. RUNNING on Kaggle does not prove optimizer progress. A PCM timestamp does not equal audible latency.

### Source-first diagnosis

- Read the entire affected ownership/state transition before adding a patch. The user explicitly asked to avoid unnecessary code and repeated tests.
- Use original game script definitions and existing runtime adapters. Do not guess native argument meanings.
- `CalculatePathForCharacter`'s third argument is **findPointTolerance**, not the NPC capsule radius.
- Native `Overlap` uses half extents and Euler rotation. Its hit Boolean is authoritative.
- Native MoveTo handlers are under `vendor/reference-game-scripts/scripts/cyberpunk/ai/commands/`. The handler reads its target in behavior updates; the path planner may still cache a destination. Source plausibility requires live consumption evidence.
- Cancel only the exact owned AI command, once, and wait for acknowledged retirement. Do not overlap commands or release an actor to autonomous follow while the old owner is uncertain.
- Do not retain native behavior contexts outside their callback lifetime.

### Focused checks and installation

Production Lua is exercised through Fengari/Node fixtures, including `bridge/companion-fixture.mjs`. Use the specific regression that covers the reported defect. Do not expand broad suites merely for a larger check count.

For Lua installation, back up the exact installed files, copy only the intended changed modules, and compare SHA-256. Avoid a whole-mod copy while unrelated dirty diagnostics exist. `scripts/Install-DevelopmentMod.ps1` is available, but inspect its scope before choosing it. It is not automatically the right tool for a one-file patch.

Lua updates normally require **CET → Reload All Mods**. Loading a save alone does not activate new Lua. A retained object may still close over old functions. Native redscript/plugin/archive changes require a game restart; prepare everything first and combine changes into one user-authorized closure/relaunch.

Keep focused local commits. Do not stage `.` or publish. Installation and committing are distinct; a committed file may not be installed and an installed native artifact may not match an edited source file.

### Live diagnostics

The installed mod has an existing nonce-based request/response interface under its `runtime` directory:

- `diagnostic-request.txt` / `diagnostic-response.txt`.
- `party-list:<nonce>` produces `party-list.txt`, including command/behavior trace rings.
- `companion-systems:<nonce>` reads systems state.
- `clearance-read:<nonce>` executes the installed `companion-clearance-probe.lua` and writes `clearance-read.json`.

Inspect existing handlers before issuing a command. Do not invent request names. Temporary read-only helpers must be backed up and restored. `party-hotpatch` is not a general live mutation escape hatch; it is safe only under its existing empty-party constraint.

Developer mode automatically records movement during gameplay in:

```text
<installed mod>\runtime\movement-trace.ndjson
<installed mod>\runtime\movement-trace.previous.ndjson
```

Capture is bounded to two 2 MiB files and up to 2 Hz, including distant companions. Copy both soon after a reported failure, before rotation. Empty Lua tables can serialize as `[]`; readers must accept that instead of assuming every field is an object. The snapshot's `command.target` can be the overall goal while `command.route.target` is the actual waypoint. A last-event field can be overwritten in the same update; the party command ring is complementary evidence.

Game-window capture tooling exists (`scripts/Capture-GameWindow.py`). The user generally prefers to perform game actions themselves. Do not use the protected input script. Prior permission to use Computer Use is not permission to bypass a tool's browser/session safety restriction. The game commonly runs on the second monitor.

### Audio and training verification

- Measure cold startup, reference preparation, first yielded PCM, first PCM received by Node, buffered playable prefix, total generation and audible onset separately.
- Record game load, CPU threads, power profile, seed, exact text, model/reference hashes, precision and sampler settings.
- Verify the production inference path, not only the training sample helper. EOS defaults and cached reference state previously differed.
- Preserve raw generated audio for comparison. Check completeness, intelligibility, pacing, likeness and grain/noise; objective similarity/loss alone cannot settle all of those.
- Never mix reference caches across model versions. Each utterance receives its own copied state.
- Do not count an API response or local “entry check” as successful preparation/training. Require real step/loss/save events and retrievable matching model bytes.

## 7. Current movement investigation — unresolved

### Latest user report

After the latest reload, one companion did not follow. Others began following only when V was too far away. The user wants running to cause departure sooner after meaningful displacement, while retaining conversational freedom to walk around nearby.

Earlier in this same investigation, followers cycled between running and idle, including after vehicle exit, first spawn, and ordinary long-distance following. Some failed to move until V stopped. These reports supersede earlier accepted post-exit behavior.

### Installed commits

**`103dce8` — admit clear native follow routes**

- Carol's blocked six-metre intermediate endpoint can fall back to four/two metres along the same native route, with full body/sweep/player checks.
- Chang's first navigation point was about 0.403 m above his actual feet at identical XY. A tightly scoped first-connector exception permits that native projection only after full collision proof. It does not increase every step height.
- Native evidence: `runtime/live-checks-20261004/support-full-sweep.json`.
- An intervening plane still blocks. Hanako's smaller height difference follows the normal rule.
- The user reloaded and still saw the cycle. This commit did not establish a complete fix.

**`53048c8` — keep clear-route movement continuous**

- Captures showed frequent cancel/reissue of MoveTo commands every 0.5–1 second, even on clear admitted routes, with repeated zero-speed frames.
- The new actuator reuses the exact active owned command across admitted same-gait, nonfinal waypoints by updating `movementTarget`; it keeps the command ID and disables repeated start behavior.
- Successor geometry still needs full admission. Gait changes use normal retirement/new command ownership.
- Handoff distance is speed-aware: `min(2.5, max(.35, speed*.4 + .25))`.
- A stall or native success far from the retargeted destination disables retargeting for that actor and falls back to fresh admission. This is scoped to the exact command ID.
- Trace events include `retarget`, `recovery-handoff-retarget`, and `retarget-not-consumed`.
- Focused same-command, repeated-horizon and gait/retirement checks passed. An older tiny-budget fixture fails before its intended successor setup; it was not counted as passed or papered over.
- Live target consumption is **not fully verified**. Later traces show some retarget events and better velocities, but command IDs still change. Do not claim solved.

Installed actuator SHA-256:
`edb0b2e4dd4621a4ebcbb1b99faef421789d7ecb3d9ee92f29becd2eb9b79a6a`

Installed clearance SHA-256:
`7fb43a535a5cc2a2393385b2bb4aca76ffb4738bdf29bf61f66927f46f67e9b4`

### Uncommitted early-running change — NOT installed

`mod/companion-travel.lua` adds:

```text
runningDeparture = rawSpeed > 3.2
                   and activeFor >= 0.2
                   and departure >= 1.2
```

This lets genuine sustained running leave a gathering/local-interaction state before the older four-metre departure boundary. It uses actual stop-anchor-to-position displacement, clears pending turn state, and preserves slow backing-up/circling behavior. A focused added test in `bridge/companion-motion.test.mjs` and two relevant existing cases passed.

This edit is preserved for review, not silently installed during the pause:

| File | SHA-256 at pause |
|---|---|
| Source `mod/companion-travel.lua` | `f4da74a51862c2538dab6f610b6b95b98d95fed47ce39a4bf4f09f63abf441dd` |
| Installed `companion-travel.lua` | `a2f4337f6a445536b918bf4253bc7f09b7a54fa2608f8fa2cd88ceb45aed6395` |

### Blue Moon blockage — separate from late departure

Blue Moon remained about 65.65 m away. Standing body checks were clear, but even a tiny next swept segment hit Static geometry. Native route generation succeeded, so navigation success alone is insufficient.

Measured root: `(-1673.16638, -453.61334, 9.299995)`; native point at the same XY: `z=9.200001`; ground near `z=8.921292`. Existing lateral detours were exhausted. The final read-only probe tested pure backward requests at 1.2 and 2.0 m. **Both also failed body/swept Static admission**, using only 16 of 144 available checks. Thus the simple backward-step hypothesis did not establish a usable path. Do not implement it as a proven solution or loosen all collision bounds.

Evidence folders:

- `runtime/follow-cycle-20261005-215236/` — original clear-route stop/run capture.
- `runtime/follow-cycle-retarget-20261005/` — after command-continuity reload.
- `runtime/blue-moon-support-20261005.json` — standing/root/nav support measurements.
- `runtime/blue-backstep-result-20261005.json` — final backward-route failures.
- `runtime/movement-install-20261005-*` and actuator backup files — installation rollback evidence.

On resumption, distinguish early departure, active-command retarget consumption, and genuine/conservative geometry blockage. They are different causal questions. Do not ask the user to repeat another car trip before using existing captures and source.

## 8. Voice models, references and measured runtime

### Accepted assets — preserve exactly

| Artifact | Location and identity |
|---|---|
| Accepted teacher | `runtime/kaggle-pocket-teacher-improve-retry-output/teacher-improve-results/teacher/export/model.safetensors` — 1,344,315,200 bytes; SHA `95d91ae4b970e51bc6270326dccf1294d576f9cb9df4f9667ebb2838c7cb0d27` |
| Accepted runtime student | `runtime/kaggle-pocket-student-transfer-ddb133ba-output/student-transfer-results/distill/export/model.safetensors` — 438,033,312 bytes; SHA `373a0df2115b1e5dc1c583bb0033838ba4ae337499831261e3938218d239a391` |
| Selected A initializer | `runtime/voice-data-expansion-20261004/a-ema500-initialization-v1/export/model.safetensors` — SHA `ce80dd672670de6b0b2aa658023db7699b1782ecff8d8a66cf1f1ec15c803fbc` |

The accepted runtime student is six layers, EMA update1500, **CPU FP32**, CFG1, one decode step, temperature0.3, two CPU threads, `frames_after_eos=1`. Do not substitute an older update6000/caa export. The teacher is a training/reference artifact, not the selected mod runtime.

Pocket source is pinned to `41cbc84af539ea78a804ffca5f9c6edc1a22ce44`. `scripts/Prepare-PocketVoices.py` produces `runtime/pocket-voices.json` from explicit approved assets and the reference registry. Four export assets and exact reference hashes are checked. Editing the config does not replace a running worker/cache; replacement requires a clean controlled worker transition after qualification.

Pocket references come from `runtime/pocket-voice-references.json`. Johnny uses the approved **22.286-second** original montage. Pocket conditions on audio; registry transcript text is metadata, not model input. Reusing an older Omni reference registry would select different Johnny audio. One warm worker owns an eight-state LRU and copies cached state per request. There is no independent neural model per character.

### What the timing evidence actually says

The October3 production-path recordings measured first finite PCM received by Node, with Cyberpunk running:

| Character | Two first-PCM observations |
|---|---:|
| Johnny | 300.3 / 285.8 ms |
| Judy | 189.8 / 196.1 ms |
| Panam | 210.2 / 243.8 ms |
| Jackie | 218.6 / 215.7 ms |
| Evelyn | 222.6 / 252.3 ms |

The first 400 ms source prefix arrived in 375.1–532.3 ms; a fresh worker startup took 18.71 seconds. These exclude Convai generation, browser/game dispatch and audible device onset. They are not an end-to-end latency promise. A separate verified CPU benchmark peaked near 1.69 GiB RAM, with no model VRAM. The student weights are 417.74 MiB; dependencies, references and process RAM are additional.

Omni uses a shared FP16 CUDA model with 16/32 sampler steps. Those numbers are **not precision or training epochs**. Chris's TensorRT/FP8 reports were useful research input, not evidence that our runtime runs TensorRT or achieves his timings. See the dedicated findings folder for licensing and exact comparisons; do not silently reinterpret third-party benchmark numbers as local measurements.

Technical reference: voice cloning findings, now outside the repo at `C:\Users\akshi\Downloads\convai voice cloning devslot\FINDINGS.md` (moved October 5). Its listening audio was removed on October 5 to keep the folder technical; the manifests still record each removed clip. Sections 1–11 cover the earlier 72-speaker stage; section 12 covers the 79-identity corpus and the October 5 teacher continuation.

## 9. Frozen expanded corpus and training plan

### Data and tiers

Final counts: **8,140 train / 79 voice identities**, dev75, conditional-dev87, regression94, final-test76 and24 references. Final-test material is excluded from checkpoint selection. Conditional/seen-scene coverage must remain labeled rather than presented as fully independent evaluation.

Tier1 contains all user priorities plus their additions:

Johnny, Jackie, Judy, Panam, Viktor, Songbird, Rogue, Reed, Evelyn, Takemura, Wakako, Mama Welles, Meredith, Mr Hands, Pepe, River, Kerry, Lizzy Wizzy, Padre, Regina, Alt, Misty, Alex and Claire.

Explicit Tier2 additions: T-Bug, Saul, Mitch, Hanako, Yorinobu, Rosalind Myers, Kurt Hansen, Jefferson Peralez and Elizabeth Peralez. Other cast members were assigned Tier2/3. The aim was more authentic data for thin speakers, not duplicating a handful of recordings until counts look balanced.

Do not invent exact per-character counts from these totals. Read the frozen manifest/inventory when asked; per-character training data is distinct from the 75/79 runtime reference availability.

### Exact frozen inputs

| Item | Identity |
|---|---|
| Final inventory | `runtime/voice-data-expansion-20261004/final-corpus-assembly/entry-inventories/final-entry-v5-frozen-001.json` |
| Inventory SHA | `b903d1ecc18e5f5d20cba4f38ee9e80a66565df6eb6f013f1816e74071a0c24f` |
| Inventory contents | 33,154 files; 7,407,141,337 bytes |
| Corpus receipt SHA | `dd45ed1da2dcc9af7e21a5953d47982c30769e1b914de7991daf6bd463b8a3a1` |
| Input ZIP | `runtime/voice-data-expansion-20261004/a-continuation-launch-v1/final-payload-v2/full-a-bcf86581b621.zip` |
| ZIP size / SHA | 3,238,633,802 bytes / `a9b7a3a4c3d19fb694f8c82dfe9889fa28fb3b7a316c736ed260ec29408ffd17` |
| Selection anchor SHA | `bcf86581b6214ebe6a61ecd2fd70243d4d2d93750c882a62646e2e41ad4a893e` |
| Private Kaggle data | dataset12357047/v1, `akshit40392/cp2077-pocket-full-a-input-a9b7a3a4-623fb987`, verified READY |

Kaggle exposes extracted files under `/kaggle/input/datasets/akshit40392/cp2077-pocket-full-a-input-a9b7a3a4-623fb987`. Large input/model staging previously took roughly 13–20 minutes. A staging heartbeat is not optimizer progress.

Additional pinned private datasets:

- Common12346972/v1: `cp2077-pocket-common-5d580bb5-f7d5fe66`.
- Teacher initializer12347119/v1: `cp2077-pocket-teacher-init-3222b51d-495a0bc5`.
- Student initializer12348421/v1: `cp2077-pocket-student-init-dda504b2-e5c58cdc`.
- A initializer12354225/v1: `cp2077-pocket-a-initialization-ce80dd67-8e134a28`.

### Intended teacher and student recipes

Teacher: selected A EMA500 weights, fresh optimizer/schedule, LR1e-5 constant after warm-up1000, EMA0.999, global batch64, microbatch4/GPU, two T4 GPUs, FP16. Up to20,000 updates. Plateau eligibility requires at least8,000 updates,50 corpus passes and8 post-baseline speech evaluations; then patience5. Evaluate every1000. Save resumable local state on a600-second timer with a300-second exit reserve; export remote firststep1, scheduled evaluation checkpoints and safe pause/end state.

Student, **not started for this expanded teacher**: accepted student initializer plus selected new teacher, LR5e-5, warm-up250, EMA0.999, global64/micro4, two T4 FP16, max12,000, minimum4,000 updates and50 passes and6 evaluations, patience4. For this corpus the pass gate pushes the first scheduled eligible evaluation to about7000 updates. Do not call a lower-step checkpoint “plateau-qualified” merely because loss is flat.

The previous launch allowed62,921 teacher execution seconds and reserved25,200 seconds (seven hours) for student/verification. These are budget/session safeguards, not proof that the desired convergence fits one run. Re-read current quota before any future launch. Select a checkpoint using actual speech/evaluation evidence; the final update is not automatically best.

## 10. Kaggle lineage and observability

### Exact runs — do not duplicate them

| Kernel/version | Slug suffix | Outcome and meaning |
|---|---|---|
| 137004941/v1 | `cp2077-full-a-teacher-278f55dd0e944d57` | Original long run, cancelled after no readable progress. No verified training output recovered; quota reservation returned. |
| 137082213/v1 | `cp2077-observable-27a5d69c20d84be6` | Completed100-update observability probe; step1 model retrieved/hashed. Last reported loss0.207935903. Small diagnostic subset, not final quality training. |
| 137084897/v1 | `cp2077-observable-d6bb6c067ab640d9` | Completed100 updates; private mid-run upload/download proven. Download began before final update. |
| 137087975/v1 | `cp2077-full-a-live-3bcb7f3d8e07453c` | Cancelled by user during staging to replace unbounded retention with three slots. No optimizer progress claimed. |
| 137089516/v1 | `cp2077-full-a-live-7af2a6f7e32049c6` | ERROR during preparation at the32.5128-second Judy source; no optimizer checkpoint. |
| **137093247/v1** | **`cp2077-full-a-live-1456408a41774075`** | Corrected source-window replacement. Submitted once; user stopped at handoff; API CANCEL_ACKNOWLEDGED22:30:42UTC. No verified optimizer progress/output. |

All slugs use owner `akshit40392`. The final notebook URL is:
<https://www.kaggle.com/code/akshit40392/cp2077-full-a-live-1456408a41774075>

Latest local receipts:
`runtime/voice-data-expansion-20261005/full-a-live/cp2077-full-a-live-1456408a41774075/`

- `attempt.json`: one acknowledged Save at22:13:10.180992UTC, kernel137093247/v1.
- `launch-bindings.json`: exact assets, overlay hashes, experiment identity and budget.
- `status.json`: latest read including cancellation.
- `source-readback.json`: acknowledged source binding.
- `kernel.ipynb`: **private credential-bearing generated source; never stage, print or share wholesale**.
- Notebook SHA: `4b30f473edaf4ccf26702cc9606d6610a0f5fafde058ec39422d43d473b2bbba`.
- Experiment/remote run ID: `full-a-20261005-1456408a`.

The last quota response reported total108,000 seconds, used19,878.382753 seconds, reserved0. This is a dated provider snapshot, not an enduring remaining-budget guarantee.

### Why the preparation override exists

Exactly one frozen training row exceeded30 seconds: Judy `1392412829519167504/female`, row2033, source32.5128125 seconds. Its1,560,615 frames at48kHz agree. The official aligned cut is17.0065 seconds, and the target after the cut including tail is13.5055 seconds. Raising **source admission** to33 seconds avoids cropping valid aligned audio; the official30-second target bound is unchanged.

Evidence: `runtime/voice-data-expansion-20261005/full-a-duration-correction/FINDING.md` and `recipe-override.json`. The corresponding three-line addition in `scripts/pocket_training/full_a_live_bootstrap.py` is **uncommitted** at pause, but was embedded in the final cancelled notebook. Do not mutate the frozen archive or silently alter a run's identity to apply it.

### Checkpoint design

The full run uses private Hugging Face bucket:
`akshitireddy/cyberpunk-pocket-rolling-checkpoints`.

There are three fixed slots per stable experiment under `runs/<run-id>/slot-0..2`. Old slot content/marker is retired before replacement; the new manifest is written last. The other two slots remain intact. A remote intent record handles a matching interrupted write. Bucket batch upload is not transactional; do not treat partially uploaded objects as a complete model.

This avoids Git history retaining all overwritten multi-gigabyte checkpoints. A four-save fixture retained2/3/4 and passed download/SHA verification; its six fixture objects were then removed. Evidence: `runtime/voice-data-expansion-20261005/rolling-bucket-live-check.json`. This proves rotation mechanics, not that the final cancelled teacher reached its first save.

The earlier proof repo, `akshitireddy/cyberpunk-pocket-training-checkpoints`, remains separate. Its verified step1 export was1,344,315,200 bytes with SHA `aaaf757390008e2fe9574f63fedcfc8ca5a08a201f8ba9f84656ad2384c08853`. Download started20:49:23UTC; final update occurred20:49:27; full hash verified20:50:41. It is a diagnostic model, not the selected teacher. Xet transport hashes and SHA-256 content hashes are distinct.

### Tools and safe resume method

- `scripts/Pocket-FullATeacher.py`: preparation, single submission, status, live stream.
- `scripts/Pocket-ObservableKaggle.py`: shared private submission/read helpers and diagnostic probe.
- `scripts/pocket_training/full_a_live_bootstrap.py`: frozen-input verification, source overlays, live heartbeat/log forwarding, runtime dependency pin and source-window override.
- `scripts/pocket_training/full_a_checkpoint.patch` / `full_a_checkpoint_hook.json`: hash-bound patch of frozen runner.
- `scripts/pocket_training/rolling_bucket_checkpoints.py`: three-slot retention.
- `scripts/Read-PocketRemoteCheckpoint.py`: identity/hash-bound retrieval, without loading Torch just to inspect a file.
- `runtime/voice-data-expansion-20261005/watch_live_teacher.py`: old bounded read-only monitor; it is not running and should not be restarted by reading this handoff.

For a read-only status refresh after resumption:

```powershell
& vendor/kaggle-env/Scripts/python.exe scripts/Pocket-FullATeacher.py status --folder runtime/voice-data-expansion-20261005/full-a-live/cp2077-full-a-live-1456408a41774075
```

Cancellation requires an actual provider session ID, not the kernel ID. The public status/GetKernel calls used here did not expose it. The user cancelled through Kaggle UI; do not guess session IDs or replay a submit to obtain one. A source Save with unknown outcome requires receipt reconciliation before another mutation.

Frozen original runner SHA:
`79488c318b52b84654064e37fdf468f6b550346d2717e108da697ed399e8f294`.

Rolling overlay runner SHA:
`4a8d8582cad5f2b5b9fc1c89917036fb191cb82a83ec1609cfadd13f50f7b47a`.

Rolling helper SHA:
`f9dba9c899e098116529a7d471ee01118e0a8b3015eac17e07ad531cb679f84d`.

The notebook verifies original payload bytes before applying declared overlays. Loader identity includes actual source/helper hashes. Do not resume optimizer state under changed code/data identity without an explicit compatible migration.

### Credentials and privacy

All four credential files below were verified to exist during this handoff. Their contents are deliberately absent from this document.

| Credential | Exact local file | Purpose and existing reader |
|---|---|---|
| Convai Core API key | `C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod\runtime\convai-key.txt` | Dialogue, character configuration, memory and cloud speech. `scripts/Start-ConversationBridge.ps1` uses this by default and passes its path through `CYBERPUNK_CONVAI_KEY_FILE`; it also accepts `-KeyFile`. Preserve the existing file format/parser. |
| Kaggle access token | `C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod\runtime\kaggle-access-token.txt` | Authenticate the authorized `akshit40392` notebook/dataset/quota operations through the existing training helpers. Do not run an older submission script's main function merely to authenticate. |
| Hugging Face checkpoint write token | `C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod\runtime\huggingface-checkpoint-token.txt` | Private checkpoint bucket/repo upload and retrieval. The current full/observable notebook builders read this file and set `HF_TOKEN` in private generated source; `scripts/Read-PocketRemoteCheckpoint.py` reads it for retrieval. |
| Earlier Hugging Face download/access token | `C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod\runtime\huggingface-token.txt` | Earlier gated Pocket/model download access. Do not assume this older token has the checkpoint-write permissions of the separate token above. |

Read credentials only inside the authorized client; never echo them. These paths are under ignored `runtime/`. The user supplied a dedicated checkpoint-write credential and authorized its private training use, not public notebook/source distribution. Existence is verified; future validity, expiry and permissions still need an actual authorized API response.

The originally mentioned personal key collection was `C:\Users\akshi\Desktop\Code Palace\Commonly used Keys.txt` (the user identified its last entry at that time). Prefer the dedicated project key above; do not scan or print unrelated personal credentials. No new token paste should be necessary unless the existing credential actually fails.

`vendor/kaggle-env/Scripts/python.exe` is the established Kaggle client environment. `vendor/pocket-tts-env/Scripts/python.exe` contains the newer Hugging Face bucket client used for checkpoint work. The legacy authentication helper is `runtime/research/submit-pocket-student-transfer-ddb133ba.py`; import only the needed authentication/read helpers, never execute its old submission main path.

## 11. Remaining work, in practical order after resumption

1. **Reconcile and resume training only when requested.** Read final cancellation and private remote manifests, preserve any complete matching checkpoint, review the uncommitted33-second admission change, then prepare exactly one coherent continuation/new run. Require visible real steps and an accessible checkpoint. No repeat A/B/C campaign, no accepted-model replacement yet. Finish teacher selection, then student distillation, then production-path audio/latency qualification.
2. **Resolve current following with existing evidence.** Review the uninstalled early-running change; separate Blue Moon geometry blockage from command-continuity behavior. Native MoveTo target consumption remains the key uncertainty. Avoid unbounded new guards and repeated user drive tests.
3. **Qualify wider vehicles/fast travel.** Overflow passenger groups, available seats, alternate owned vehicles, convoy departure/cleanup and travel recovery still need real use. Source corrections `fb6dd3b` and `55e3307` retain seats/one recovery handoff and defer fleet spawning while the primary car moves. Do not count source tests as completed gameplay.
4. **Close specific chauffeur/caption cases.** Boarding pause when V does not follow is not yet captured reliably. Do not invent a distance gate. Installed subtitle mount fix `55dc2f9` needs a natural visual observation, not another speculative change.
5. **Relationship/personality/quest acceptance.** All five relationship controls exist. Actual relevant-save profile routing, group audience boundaries and natural branch recall need selective gameplay. The eight priority quest lanes are already integrated; do not do them again because an old TODO says pending.
6. **Expressions.** Light resting smile is source behavior. Real Convai emotion should be admitted only when its turn/response ownership is reliable. No real correlated backend emotion has yet closed that acceptance path; do not manufacture success.
7. **Concrete conversation/reaction gaps.** Mixed-provider groups/cancellation, duplicate-copy reassignment/dismissal, simultaneous combat+loot queue, Legendary pickup, newly unlocked contact refresh, and non-destructive Memory picker/cancel feedback. Unsupported loot event routes remain disabled. Do not clear real memory without the user's selected target.
8. **Packaging later.** Finish portable dependencies, generated reference extraction, first-run credentials/profile setup, hidden service lifecycle and version handshake, then Lua-only Scripts ZIP plus non-Lua Runtime ZIP. Clean relocated install/update, measured sizes and license notices remain necessary. Do not include keys, player IDs/history, captured audio, game recordings, training data or huge research artifacts. No release/publication is currently authorized.

Explicitly deferred/not requested: further blink/eye-contact work, per-character provider selection, disappearing messages, ordinary save-load party respawn, mandatory listening gates for every reference, combined combat/loot responses, unreliable exploration dialogue capture, and private/group mic gameplay testing. Multilingual interface is done; multilingual cloned voice qualification is optional future work.

## 12. Git, unfinished edits, rollback and cleanup

### Source state at pause

HEAD before adding this handoff: **`53048c8`**.

Uncommitted files intentionally preserved:

| File | Meaning |
|---|---|
| `mod/companion-travel.lua` | Early sustained-running departure; not installed. |
| `bridge/companion-motion.test.mjs` | Focused regression for that change. |
| `scripts/pocket_training/full_a_live_bootstrap.py` | 33-second source-admission override used in latest cancelled notebook. |
| `mod/diagnostics.lua` | Unrelated protected dirty state; do not edit/stage/install. |
| `scripts/Test-GameInput.ps1` | Unrelated protected untracked file; do not read/execute/stage. |

The handoff documentation may have a later docs-only commit. That does not mean these edits were installed or committed. Check `git status --short` before acting.

Useful rollback/history anchors:

| Commit | Subject |
|---|---|
| `53048c8` | Clear-route command continuity, installed; native acceptance incomplete. |
| `103dce8` | Shorter admitted route prefixes and scoped native height seam. |
| `6903750` | Three rotating teacher checkpoint slots. |
| `9731ef0` | Full teacher launch with durable checkpoints, earlier retention design. |
| `acb9f41`, `e1bab8c`, `caae80d`, `f2d5df4` | Observable probes, upload and actual mid-run retrieval proof. |
| `8092db8` | Persistent bounded Developer-mode movement logger. |
| `55e3307` | Defer overflow vehicle creation while primary moves. |
| `d68a7d9` | Settings guidance/localization, no Apply instructions. |
| `4f71897` | Frozen group actor/profile ownership on reassignment/dismissal. |
| `15b3a59` | Pocket production `frames_after_eos=1` parity. |
| `b28ee0c` | Eight priority character quest lanes integrated. |
| `135c5d3` | Pocket/Omni mouth smoothing. |
| `986ad09` | Invitation failure latching and notification dedupe. |
| `fb6dd3b` | Driver-seat and single recovery-handoff lifecycle. |
| `c2b5a78` | Restored parked owned-car discovery. |
| `016f2cd` | Resident Pocket acoustic-phone analyser. |
| `08f6dd4` | Restore four voice choices. |
| `e2d9222` | Clothed Kerry appearance. |
| `9da88fc`, `6863401` | Pocket CPU integration and facial-source/drain corrections. |

Use `git show` and selected paths for rollback review. Do not reset the whole working tree. Historical fixture failures are not all caused by the latest patch; inspect causal setup before changing assertions.

### Storage cleanup history

The project previously exceeded200GB. Retired experiments, duplicate archives, old caches and rejected model copies were cleaned while preserving accepted/frozen assets. One recorded retirement removed42.924GB (39.98GiB), with earlier16.08GiB and6.71GiB cleanups documented separately. Do not add these figures without checking receipt overlap. `runtime/cleanup-retired-20261004/result.json` is the exact removal receipt.

Do not repeat broad deletion from stale lists. Preserve original cast audio, final corpus/input ZIP, current teacher/student/A initializer, source/native evidence, listening samples and checkpoint manifests. Resolve every recursive Windows deletion target to an intended absolute workspace path first; use one shell end-to-end. The newer disk snapshot and unexecuted cleanup plan are below.

### Cleanup requested during this handoff

The user additionally requested obsolete folders/datasets/backups be removed, with **no new copies or backups**. Thirteen redundant Markdown notes were directly removed after consolidation. The large-file/folder deletion attempts were rejected by automatic command review, including an exact single smoke-model deletion; they were **not performed** and no reclaimed-space claim is made.

At the user's request, the blocked cleanup is prepared in [Clear Obsolete Voice Files.bat](Clear%20Obsolete%20Voice%20Files.bat), which calls `scripts/Clear-ObsoleteHandoffFiles.ps1`. Double-click it locally to remove only its explicit reviewed targets. Its read-only `-ListOnly` path was exercised; the destructive path has not been run by the agent.

It selects two downloaded diagnostic step1 models, the superseded earlier cast ZIP, one SHA-matched duplicate A-initializer upload ZIP, rejected VoxCPM2/Chatterbox runtime/model directories and their bounded model views, and old project backup folders/probe copies. It does **not** select the accepted teacher/student, A initializer export, final8140 corpus/payload, original dialogue, Pocket/Omni runtime dependencies, credentials, listening audio, or current training/movement receipts. The older cast archive is superseded; it is not the final full-A ZIP.

The two A-initializer ZIP copies both hashed `37536b839814b2e78d7192f88a6a09254343a125db834f015f2e540177f834f5`; only the nested upload staging copy is selected. File-size inventory can overcount hardlinks/symlinks, so logical totals are not a promised amount of freed disk. A read-only disk snapshot during cleanup preparation showed126,263,341,056 bytes free on C:.

The launcher checks workspace-contained absolute paths and rejects reparse-point ancestors. It refuses cleanup while the owned bridge/voice worker is active, creates no backup/archive, and writes only `runtime/handoff-cleanup-result-20261005.json` with removed/failed targets. After running, consult that receipt: references above to installation backup directories are historical and those copies may be gone; use Git for tracked source history. Do not mistake the existence of the launcher for completed deletion.

## 13. Reading map and evidence index

Start with this file, then only the documents relevant to the resumed task:

- [Player README](README.md).
- [Current remaining work](#11-remaining-work-in-practical-order-after-resumption) — this replaces the former TODO and dated pending-work notes.
- [Movement design](docs/COMPANION_MOVEMENT_DESIGN.md), [recovery transactions](docs/COMPANION_RECOVERY_TRANSACTIONS.md), [clearance](docs/COMPANION_CLEARANCE.md).
- [Chauffeur](docs/COMPANION_CHAUFFEUR.md), [vehicles](docs/COMPANION_VEHICLES_DESIGN.md), [invitations](docs/COMPANION_INVITATIONS.md).
- [Phone Chat](docs/PHONE_CHAT.md), [memory](docs/PLAYER_MEMORY.md), [Chat reset](docs/CHAT_MEMORY_RESET.md), [relationships](docs/RELATIONSHIP_PROFILES.md).
- [Pocket runtime](docs/POCKET_TTS_RUNTIME.md), [resident phone analysis](docs/RESIDENT_PHONE_ANALYSIS.md), [Pocket stream lip sync](docs/POCKET_STREAM_LIPSYNC.md), [Convai streaming](docs/CONVAI_AUDIO_STREAMING.md), [expressions](docs/COMPANION_EXPRESSIONS.md).
- [Voice training](docs/VOICE_TRAINING.md) — older overview; use this handoff's cloud table for current state.
- [Research/team findings with audio tables](convai%20voice%20cloning%20devslot/FINDINGS.md).
- [Priority quest coverage](docs/QUEST_PRIORITY_COVERAGE_2026-10-04.md), [knowledge coverage](docs/CHARACTER_KNOWLEDGE_COVERAGE_2026-10-01.md), `research/cyberpunk/generated/native-coverage.json`.
- [Packaging](docs/PACKAGING.md), `packaging/RUNTIME_BOOTSTRAP.md`, `packaging/release-plan.json` — deferred, not a finished release.
- `runtime/voice-data-expansion-20261005/STATUS.md` — stop notice and latest cloud pointer; older sections are historical.
- `runtime/voice-data-expansion-20261003/ROOT_STATUS.md` — retained experiment provenance, not current marching orders. Superseded root PAUSED notes are archived as described below.

## 14. Consolidated notes and additional historical lessons

At the user's request, the eight root `PAUSED*.md` files, root `TODO.md`, three dated October1 progress/restart/integration notes, and `research/cyberpunk/WORK_PLAN.md` were merged into this handoff's history and current backlog, then removed from the active document tree. There is now one current handoff/backlog rather than several conflicting next-step lists.

The user explicitly requested no additional copies or backups. No archive was created; the useful current decisions and pending work were merged here before direct removal. Previously tracked notes remain recoverable from Git history. Technical feature documents, native-source reviews, audio manifests, frozen training receipts and research references were retained because they still explain or support implemented behavior.

Additional lessons carried forward from those notes:

- The earliest phone UI attached controls under the wrong widget layer. Use the selected row's native hint parent and actual live widget tree; a compiler pass could not expose the occlusion.
- Replaying a stale diagnostic spawn request on startup once caused save-load crashes. Nonces/lifecycle ownership matter; do not replay old diagnostic actions automatically.
- Native green companion minimap markers made a custom marker hook unnecessary. Do not recreate a duplicate marker system.
- A native Chat list clear once remained pending because the list controller's update/push semantics were not completed. Calling Refresh merely because size was zero did not solve it. That historical failure is already fixed; don't revive the rejected patch.
- CET player wrappers cannot always be compared as Lua objects; speech ownership was corrected to use stable entity IDs.
- One latency bug repeatedly parsed a roughly515KB raw-input structure. Guarding unchanged input improved observed onset estimates from about5.05s to4.06/3.70s in that historical route; these were not controlled provider benchmarks and are not current timing promises.
- The earlier prompting pilot measured36 replies in18 two-turn exchanges. Model-authored blinded mean scores were72.29 baseline,66.46 added directions,68.44 directions plus native examples. That small experiment did not support replacing every profile prompt. Preserve source-faithful examples and use actual conversational evidence instead of assuming longer instructions are better. See `research/cyberpunk/dialogue-style/`.
- Separate relationship profile IDs have separate remote memories. One end-user UUID does not merge all profile/session memories. Bounded genuine conversation context can provide continuity; do not copy/seed invented remote memories. Group audience guards also do not establish a provider-level hard privacy partition of shared long-term memory.
- Jake's stronger intrinsic pack was held for inadequate native identity/source proof; the earlier researched profile was retained. Resident templates are archetypes, not invented canonical people.
- A historical Codex configuration change requested a million-token context setting and25 concurrent child slots. Old notes recorded effective telemetry for that session. Do not assume those values describe a new agent session or modify global Codex settings on resume. Use the current session's reported capabilities; current inheritance preferences take precedence over old model names.

The current feature history, accepted/deferred distinctions, native verification gaps, cloud cancellation and uncommitted edits above supersede old “source only,” “running,” “next reload” and model-selection statements in the removed notes.

**Bottom line for the next agent:** the user has a substantial working mod, an accepted CPU voice student, and a much larger frozen dataset. The expanded final teacher/student has not completed. Following still has real defects despite earlier isolated acceptance. Work is stopped. Preserve the current state, communicate accurately, and resume only the user's chosen next task.
