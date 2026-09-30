# Cyberpunk Convai overhaul

## October 1 — immediate voice preparation and remaining controls

- [x] Implement Omni model loading/warmup immediately when its MCM selector
  changes, before Apply or a conversation. Supported draft events drive a
  bounded preview lease; routing stays fixed for current replies, Apply reuses
  the prepared worker, and Revert/close safely release preview-only memory.
  82 focused checks pass, including installed MCM. See `docs/VOICE_PREPARATION.md`.
- [ ] Verify an actual unsaved selector change reaches Loading → Preparing
  voices → Ready, then validate Apply/revert behavior against the resident worker.
- [ ] Activate the already-prepared eye-contact height/head-strength controls
  with the same Lua update and qualify their live behavior as the next TODO.

## September 30 — active continuation

- [x] Implement F9 group microphone routing with the addressed speaker first,
  frozen distinct audience, finalized recognized speech for later members,
  one first reply, and lifecycle cancellation. F7 remains private. Source and
  simulated adapter/transport checks pass; live microphone use is user-deferred.
  See `docs/GROUP_VOICE.md`.
- [x] Diagnose the reported micro-gaps and uneven lip sync. Retained Judy audio
  contains seven completed files with estimated 15–32 ms handoff gaps. Convai
  receives one text request; the adapter subdivides returned audio. Omni alone
  splits reply text for TTS. Validated ARKit poses now survive quiet phonemes
  instead of being gated to neutral by per-file RMS, with existing calibration.
- [x] Replace Convai's browser recapture and separate clip handoffs with original
  reliable PCM and indexed NeuroSync in one native WAV. The real production
  transport check returned a complete 3.05-second clip and 183 frames at 60 FPS.
  Handle the provider's mixed envelopes and unlabelled owned terminal. Keep
  Omni's text/voice batching separate. Source `748511f`; installed without a
  game restart. Quiet-boundary masking was set aside without installation.
- [x] Complete the full system audit and confirmed fixes in
  `docs/DEVELOPMENT_AUDIT_2026-09-30.md`, including methods and verification limits.
  Final full suite: 1,159 passed, no failures/skips, including installed MCM.
  Fixed connection retention, heartbeat reads, automatic-memory Forget targets,
  phone persistence, native command ownership, worker hangs, quest-context
  relevance, selectors, evidence validation, packaging and build freshness.
  Local Git checkpoints preserve rollback; 42 installed files hash verified.
- [x] Activate the combined update with CET reload and check Judy's Convai F6
  voice. The user confirms smooth playback. The installed receipt has one
  7.417-second native clip, no stream handoffs, and a completed facial reset.
- [x] Implement a separate continuous Convai PCM queue with game-owned admission,
  current volume/pan, pause/cancellation, device-cursor faces and audible group
  completion. Keep Omni's phrase generation separate. No full-file wait on the
  new remote route. `docs/CONVAI_AUDIO_STREAMING.md` describes the protocol;
  checkpoint `a55c178`. Combined 1,266 checks passed; a later diagnostic-only
  client follow-up passed 55 targeted checks. Installed 43 Lua/catalogue files
  with hash verification, fresh bundle and hidden bridge; nine native hashes
  unchanged and no game restart. CET activation and live acceptance are pending.
- [x] Document the requested Lua-only Scripts ZIP and non-Lua Runtime ZIP in
  `docs/PACKAGING.md` and `packaging/release-plan.json`. The 40 Lua files and
  native/voice dependencies are inventoried. Portable bootstrap, relocation,
  distribution notices and archive-size qualification remain release work;
  no archives or GitHub release have been created.
- [x] Verify continuous Convai onset: the user reports **good latency** after
  correcting native Dialogue Volume from 0. The earlier whole-WAV buffering
  delay is superseded by continuous playback. The generation/quantum-clock
  corrections in `7baf303` passed 90 focused checks; the latest 8.8167-second
  reply drained with zero underruns and neutral facial cleanup.
- [x] Deeply review practical lip-sync systems and Cyberpunk's native rig.
  See `docs/LIPSYNC_DEEP_DIVE_2026-09-30.md`: primary sources, current Convai
  guidance, JALI/native solver, actual Judy geometry, GPU alternatives,
  licensing/resource limits and calibration method. Retain Convai NeuroSync;
  native retargeting and sampling are the immediate improvement path.
- [x] Accept current Convai articulation on Judy. On October 1 the user called
  v10 "good enough." The original wooden/simple mouth diagnosis found only 146 native
  applications over 8.8167 seconds despite 60 Hz source data. Integrated Lua
  replay reproduces poll quantization; the correction uses a bounded confirmed
  past audio cursor each game frame. Native Judy analysis also identified a
  wrong mouth-corner target and discarded lower-lip roll. Source fixes,
  installation and fresh rendered acceptance are recorded in the deep dive;
  numeric checks alone do not close this item.
  Phone history across reload remains a separate live follow-up.
  - October 1: the user accepts jaw opening and smoother motion, and reports
    that v6's stronger round/wide shapes are better but need more improvement.
    Direct second-monitor game-window captures prove these native channels
    work at High LOD. The v7 candidate adds separately calibrated lip contact
    and upper-lip lift; 78 source checks and two-rig geometry review pass.
    V7 is installed and captured; the user reports "not bad, keep improving."
    Visible closure and reset improve, but final naturalness remains open. See
    `docs/NATIVE_FACIAL_RETARGET_CALIBRATION.md` for captures and limitations.
  - Added source-driven upper-lip roll in v8, after a fixed-jaw native range
    comparison. The same saved voice/source pair replays through v7/v8 without
    another provider call; both captures finish with native facial reset.
    V8 is live, 97 focused checks pass, and the helper can trigger future
    comparisons without asking the user to send every F6 message. This is a
    modest contour improvement; overall naturalness and other rendered rigs
    remain open. All captures are bounded and the normal bridge is restored.
  - Continued with actual model-space hierarchy analysis: v9 preserves separate
    left/right LowerDown motion, while v10 separates JawOpen from MouthClose
    so lip contact uses the native open-jaw correctives. Directional and full
    jaw-range closure probes are visually inspected on Judy. Both paired voiced
    comparisons complete and reset; v10 is live without a game/CET restart.
    100 focused checks pass. Cropped captures now observe roughly 24–28 FPS,
    supporting brief-transition inspection. Overall naturalness, expressions
    and other characters' rendered qualification remain open.
- [x] Carry compatible native-rig calibration into Omni's separate phonetic
  poses. `coarticulated-v5` adds calibrated contact, contextual jaw motion through
  brief closures, stronger corners, budgeted lip lift and corrected G/H targets.
  117 focused checks pass. A native maximum-pose sweep and old/new replay of the
  same saved OmniVoice 32 WAV complete and reset; Convai's accepted 446-frame
  output is unchanged. The bridge is restored and no reload is needed. Exact
  F/V contact, tongue detail and other characters' rendering retain visual
  limits documented in `docs/LIPSYNC_REFINEMENT.md`.
- [x] Add **Follow-up questions** (`followUpQuestions`) to organized Settings,
  default Off per the user's latest request. Local checkpoint `135264d`; 991
  tests passed with zero failures/skips, including installed MCM integration.
  Private, phone and microphone turns retain their captured preference; group
  rounds keep it for all speakers, and only the final remaining speaker may ask
  when enabled. Automatic reactions never ask. Lua files/catalogues were hash
  verified on installation and the reply bridge restarted successfully.
- [x] Diagnose enabled follow-ups being omitted: the setting reached the bridge
  correctly, while the prompt only said a question was permitted. On now requests
  one relevant question, with goodbye/no-question/fixed-reply exceptions. Default
  Off and existing saved On choices are preserved. Source checkpoint `2ede95e`.
- [x] Remove speaker labels from all 618 examples across 79 profiles, including
  extracting only the character's response from V/character pairs. Production
  serializers and preflight prevent the labels from returning. All 79 existing
  cloud profiles were read back with biographies, voices, model configuration
  and ID mappings preserved. Source `5a3686b`; wrapper `7a54e1d`.
- [x] Check real provider behavior using the existing isolated research ID.
  8ug8ear/Judy/Johnny On/Off and group-first/last behaved correctly. One goodbye
  failure prompted clearer priority wording; the four targeted follow-up checks
  then passed. All 14 post-repair replies omitted name prefixes. This is text-only
  sampled behavior, not live voice acceptance across the whole cast.
- [x] Use the native default red and a common left edge for Companion Manager
  labels and section names. Initial `c6aed7a` did not apply in game because MCM
  publishes the real page title after rendering rows. Live widget readback
  identified that boundary; `4fe8a9b` styles the completed owned page and retains
  cyan option boxes. 1009 full-suite checks pass, including installed MCM
  integration; the 28 manager checks passed again after the final owner guard.
- [x] Make accepted Escape/close from Companion Manager resume gameplay through
  the native Resume action. The user confirmed it still returned to Pause after
  `2e2a07a`. CET creates distinct weak-reference wrappers for callbacks on the
  same menu, so Lua equality missed the close/detach. The correction correlates
  native `CalcSeed` identities while preserving MCM's draft guard and other pages;
  fresh-wrapper regression checks reproduce the previous failure. Source
  `9d4320d`; 40 focused checks pass, including installed MCM integration. After
  CET reload the user confirmed Esc returns to gameplay. Live readback reports
  one matched close, one detach, one native Resume, zero identity failures and
  no retained settings/presentation controller. The unsaved-change dialog's
  exact in-game flow remains covered by source checks rather than user testing.
- [x] Remove the close-face retreat caused by V being within 0.72 metres. Keep
  separation between overlapping companion copies and ordinary following.
  Source `9e14265`; reproduced old failures, then 64 movement/behavior/equipment
  checks passed. Lua/catalogues installed and hash verified as one update.
- [x] Activate the corrected menu styling (`2e2a07a`) through CET reload. The user
  confirmed normal opening, correct default-red labels and correct indentation.
  Live readback confirms one x=20 label column, native red, no style error and
  the saved follow-up On choice retained. Cyan option controls stay native.
  The first final-title update (`4fe8a9b`) crashed on F4 after reload and was
  reverted in `c6ef43b`; the game was relaunched and the user confirmed the old
  manager opens normally. The corrected implementation queues styling for
  top-level update, performs one lookup/map, and passes 37 focused manager/exit
  checks. Native crash evidence and limits are in `docs/MANAGER_UI.md`.
- [x] Check a companion staying put during a close approach. After CET reload,
  the user walked up to her face and confirmed she did not back away. The
  separate follow-after-departure case has source coverage and earlier acceptance;
  it was not explicitly re-observed in this latest close-up report.
- [x] Hear a private On reply with a relevant question and no name prefix.
  The user confirmed both in Judy's F6 reply. Opt-in group listening remains
  unverified; live microphone testing is still deferred.
  See `docs/FOLLOW_UP_QUESTIONS.md`.
- Keep one persistent player ID across saves, characters and channels. Invite
  may prepare the requested profile immediately, without recording contact or
  creating proactive memories; actual conversations build memory naturally.
- Follow-up live work uses manual game input. Cyberpunk is running. The user
  explicitly authorized GPU use and overrode `gpu use.txt`; power-profile changes
  should still be requested before a performance comparison.

## September 30 — player memory simplification

The latest user decision replaces save/timeline memory with **one persistent
player ID across all saves and characters**, natural conversation memory, and
explicit Forget controls. No proactive memory creation for unused characters.
See `docs/PLAYER_MEMORY.md` for the current runtime contract.

- [x] Install invitation preparation and organized Settings from `9290ab3`.
  September 30: 983 checks passed with no failures/skips; Lua/catalogue copies
  were hash verified. The restarted bridge reports ready memory, the same
  identity anchor and one existing contacted character. Cyberpunk was launched.
  Subsequent accepted checks and remaining gaps are listed below.
- [x] Verify the new **Settings → Memory → Manage** submenu and grouped Settings
  page in the game. The user confirmed Memory opens separately and Back to settings works.
- [x] Gate NPC creation on memory configuration and an identified private
  connection, starting preparation at **Invite**. Source/framework checks cover
  paused MCM/Contacts, stale readiness, cancellation and attachment. The user
  confirmed Judy joined after closing the manager, and her first send reused
  the prepared page and SDK connection. This gate applies to assigned AI profiles;
  a raw model with no conversation profile is explicitly model-only.
- [ ] Visually verify **Preparing memory → Connecting → Ready to join** while
  MCM/Contacts stays open, and cancel an invitation there. These transitions and
  cancellation have executable coverage; that exact visible flow is unconfirmed.
- [x] Verify the prepared page survives Judy's invitation and first F6 send.
  September 30 live trace: page and SDK connection reused, memory admission
  7.8 ms, pool wait 0.073 ms, native playback onset about 4.9 seconds versus the
  earlier 19.6-second trace. This is one observed turn, not a provider guarantee.
  The user confirmed Judy joined after closing the manager.

- [x] Install the single-ID memory runtime and native MCM controls. September 30:
  926 checks passed with zero failures/skips, the browser bundle rebuilt, Lua
  files/catalogues hash verified, and the bridge reports a matching identity
  anchor and fresh ready status. Local voice state is remote; Cyberpunk launched.
  Main feature checkpoint: `a361f13`; voice fixes: `44e7c4d`, `ae7d2e1`.
- [ ] Live-check the single-ID route across private, group, phone and microphone
  chat; source routing and isolated startup tests are available.
- [ ] Check natural recall with an already contacted character across later
  conversations and a normal save/launch cycle. Use the same player ID and let
  actual dialogue build memory; do not seed it through additional requests.
- [ ] Live-check Memory's unspawned character picker,
  inline Confirm/Cancel and exact clear feedback. All targets only contacted
  profiles. The player ID remains the same after both clears.
- [ ] Live-check the wider Convai ARKit mouth-opening correction. Controlled
  facial/audio tests pass; visible acceptance remains pending.
- Native/save/fact identity and explicit memory-seeding/archive experiments
  are superseded. Keep their research as historical evidence, outside production.

## September 30 — deep character knowledge

This is the new granular knowledge request, separate from the already accepted
tracked-objective feature below. Research counts are from generated reports at
2026-09-29 22:40 UTC (September 30 locally); rollout status includes the later
Core readback, live streamed reply, read-only identity probe and reviewed prompt pilot.

- [x] Create a dedicated `research/cyberpunk/` workspace with repeatable public
  collection, installed-resource extraction, source manifests and exact evidence
  references. Blocked/incomplete sources remain recorded; raw caches are ignored.
- [x] Author all 79 dossiers with individual biographies, speaking styles,
  original examples, relationships and knowledge limits. Independent review now
  covers all 79 and all 618 example entries; all 16 findings were corrected.
  See `research/cyberpunk/PROFILE_CROSS_REVIEW.md` and its city peer review.
- [x] Cross-reference the current narrative corpus: 253 quest keys, 704 decisions
  and 1,160 outcomes. Compile 172 source-verified native rules linked to 166
  outcomes, with 271 artifacts and 3,467 checked pointers. This is source evidence,
  not confirmation that every rule has run in the game.
- [ ] Expand the remaining 994 explicitly unmapped outcomes. They stay excluded
  from executable context/memory until exact conditions, narrative meaning and
  audience are verified. See `research/cyberpunk/generated/native-coverage.json`.
- [x] Apply the researched baseline through the three separate Core API fields:
  all 79 profiles' exact field hashes and selected model passed readback.
  Existing character IDs and voice assignments were preserved. This is separate
  from the new style experiment.
- [x] Record 36 measured text replies for the Johnny/Judy/Panam prompting pilot.
- [x] Complete model-authored blind review: baseline 72.29/100, added directions
  66.46, directions plus native examples 68.44. No broad production style change
  is justified by this small run; the researched baseline remains in place.
- [ ] Follow up individual prompting hypotheses with fresh/repeated scenarios
  and user conversation/listening checks. These scores do not establish human
  preference. See `research/cyberpunk/dialogue-style/UNBLINDED_REVIEW.md`.
- [x] Checkpoint knowledge (`857af7c`) and streaming (`27d6c55`); install the new
  Lua/context/audio update with the quarantined native class excluded.
- [ ] Complete live checks of granular context across private, phone, group and
  microphone routes. The new runtime is active; the earlier
  read-only 2.31 capture is narrower than full runtime acceptance.
- The native save-identity component remains quarantined and excluded from
  installers. The one-ID policy does not need it; repair is no longer a gate.
- [x] Run the installed read-only identity probe: all 43 fact reads returned zero,
  current world scope was accepted and the restore observer registered.
- [x] Observe actual `OnGameRestored` delivery during the user's save reload:
  one restore and two successful read-only samples, with zero fact writes.
  This event now retires transient world work; it stores no save identity.
- [x] Qualify explicit memory API ownership using a disposable character and
  separate A/B users. Add/list/get isolation, cross-user HTTP 403, memory cleanup
  and temporary-character deletion passed. This did not enable production memory.
- Explicit REST archive qualification is superseded by the user's natural
  conversation-memory decision. Preserve the disposable evidence; do not resume
  its automated probes or `/memory/add` work.
- [x] Complete one live streamed Convai reply in eight chunks: about 2.16 s to
  first provider audio on a warm connection and 5.05 s from request to estimated
  native speech. The user still finds it slow.
- [x] User accepted improved response timing after the raw-input cancellation
  guard removed repeated 515 KB parsing. Observed native-onset estimates fell
  from 5.05 s to 4.06/3.70 s; this was not a controlled provider benchmark.
- [ ] Broader audible continuity, face timing and cancellation acceptance.

Detailed design, evidence boundaries and remaining steps are in
`research/cyberpunk/README.md` and `research/cyberpunk/WORK_PLAN.md`.

## September 29 — current direction

- [x] September 30: batch reactions to confirmed item-specific world loot, default On with an independent MCM setting. Installed and hash-verified at 01:00 IST (`ac609bc`), reply bridge restarted and CET activation confirmed. The user heard Judy's first loot comment; the trace shows one quantity-two receipt, one request after the six-second collection wait and completed playback. Real drink/stack pickup and vehicle-storage event ordering captured; storage returns are nonsilent and the observer explicitly excludes storage sources. 110 standard checks plus the separate installed-MCM integration check pass. See `docs/LOOT_REACTIONS.md`.
- [ ] Live-check combined battle/loot comments, the Legendary exception and silence after storage withdrawals. Merging, cooldowns and storage exclusion are implemented with fixture coverage. Corpse loot-all and virtual pickup paths remain unqualified.
- [x] September 30: fix Judy remaining armed after combat. The equipment owner yields the exact standing command to native holstering, then restores standing. The player threat gate excludes location-only memories (`7ccdfd2`). The user confirmed she holstered; both active Judy copies independently report one successful unequip, empty hands and resumed standing holds. Twenty-four equipment checks and the prior 42 movement/record checks pass. See `docs/COMPANION_COMBAT.md` and ignored `runtime/equipment-holster-accepted-20260930.json`.
- [ ] Deferred by the user September 30: reactions to V's solo exploration remarks. Cyberpunk's subtitle callback does not prove solo-scene provenance, and sampled self-addressed lines also belong to Johnny conversations. The user asked to skip this unless a reliable automatic source is found. No reaction or new setting is enabled; the read-only capture is stopped. Research/prototypes are preserved under ignored `runtime/exploration-research/`, with the limitations in `docs/EXPLORATION_RESEARCH.md`.
- [ ] September 30: optional native overhead subtitles. The user rejected the initial high placement and short fragments and requested the previous dialogue HUD as default. Restored the live/saved HUD preference and new-install/MCM defaults; overhead captions keep short sentences together up to 120 Unicode characters. The first height adjustment from 30 cm to 5 cm was visually too low; raised to 15 cm after feedback. Optional layout visual acceptance remains pending. See `docs/OVERHEAD_SUBTITLES.md`.
- For future loot tests, place a small test bag near V. The user requested this after having to find a pickup; the on-demand two-drink diagnostic preserves the pre-existing inventory quantity.
- [x] Correct all 79 Convai profiles to use separate `backstory`, `speaking_style_description`, and `speaking_style_sample_dialogues` fields. Completed September 30 (IST): all 77 named and two ambient profiles were updated in place and each field matched Core API readback. IDs, names, voices, model and memory configuration were preserved. Both provisioning entry points share the corrected mapper; four provisioning regressions and one routing check pass. Installed roster hash verified and background service refreshed without restarting the game. See `docs/CHARACTER_API.md`.
- Resumed at the user's request. Installed the combined phone repair and battle diagnostics while Cyberpunk was closed, then launched it; native startup compilation succeeded at 23:22:28 IST. Prior pause evidence remains in `PAUSED_PROGRESS_2026-09-29_PHONE_BATTLE.md`.
- [x] Fix reused phone Chat rows showing another contact's AI history or newly received native SMS. Native `Clear()` was deferred; the installed repair uses `Clear(true)` and guards queued journal events. Twenty-two focused phone checks pass. The user confirmed histories are separate after switching contacts; a live Babs panel also matched her two stored lines exactly and had zero quest choices. Saved histories remain intact. Local implementation checkpoint `5afae94`.
- [x] Battle awareness and automatic opening/closing comments: default-On MCM control, nearby witnesses, ten-minute cooldown, save/session reset, conversation/story priority and request-owned cancellation. The user heard both comments after the native-speech waiting fix. Cooldown/save-reset edge cases have automated coverage; loot merging is installed pending live acceptance, and exploration merging is not yet implemented. See `docs/BATTLE_REACTIONS.md`.
  - First live fight: user heard neither comment. Both requests started, then the adapter cancelled them before delivery. Specific cancellation evidence and output gating were installed; the resumed phone/battle run passed 42 focused checks. The original log combined multiple causes; the next live diagnostic identified the guard as recorded below.
  - Second fight identified `native-dialogue` on Judy two seconds into opening generation, with other guards clear. A pending reply now waits for autonomous native speech and rechecks before playback; it keeps its original deadline and still yields to story/manual interruptions. Twenty-three focused battle/lease checks pass. After CET reload, the user confirmed both opening and closing comments; the closing completed, while a later native line interrupted the opening after about two seconds. Checkpoint `ea82798`.
- Voice tuning is deferred at the user's request. Keep the accepted FP16 OmniVoice route and 32/16 generation-step setting; these are inference steps, not training epochs. FP8 is an experiment, not a shipped precision option.
- [x] Expose an explicit Convai voice-provider choice for the three local-voice characters. MCM selects default hybrid OmniVoice/Convai or Convai for everyone, with idle-boundary changes, graceful GPU release, and one-worker warmup when switching back. All 37 applicable focused checks passed across the suite and actual installed-MCM API run. The user selected Convai and confirmed Judy's voiced/subtitled reply; the worker exited and reported zero CUDA allocation. Reverse switching has lifecycle-test coverage, not a repeated live playback check. This is a manual choice; failed local speech still preserves the written reply rather than silently issuing another dialogue turn.
- [x] Separate native **Chat** tab beside Contacts, direct per-person conversations, and a composer fixed at the bottom. The user accepted the corrected matching tab style, removed quest suggestions and cyan Enter/Esc hint inside the composer. Installed without an extra restart; checkpoint `835236b`. See `docs/PHONE_CHAT.md`.
- [x] Keep the phone's Enter/Esc hint out of F6/F8 and other text inputs. An inherited Codeware focus callback was applying the phone placeholder outside its widget tree. Ownership is now checked before any change; the original world prompt is restored without editing drafts. Twenty focused phone checks pass, and the user confirmed the original in-world prompt live without a reload.
- [x] Current-save quest awareness: tracked-quest/active-objective capture is installed, with frozen group snapshots and bounded traversal. After the context wording correction, the user confirmed it works. The subsequent live Judy reply correctly referred to checking Muamar's message under the newly tracked **Freedom** quest, demonstrating that context refreshes. All 53 affected checks pass; F8/phone/microphone routing has code coverage rather than separate user acceptance. See `docs/QUEST_CONTEXT.md`.
- [ ] Add **Disappearing messages** to MCM, default Off: clear local Chat history/drafts at each new game launch when enabled, preserving Convai memory. Implemented with actual process-launch identity; lifecycle and session-reuse tests pass. Live launch acceptance is pending. CET reloads and save loads must retain current history.

This is the running request and verification list. A checked item means the behavior was seen in the game or directly verified; code alone does not close an item. Update this file when a request is added or a test changes the result.

## Companion experience

- [x] September 29: fix Johnny fleeing instead of fighting. The original record lacked a combat loadout and weapon-use abilities. A private summoned-copy record now supplies ranged capabilities and his Malorian. Native readback confirmed the active abilities/loadout and unchanged source/donor fields; the user confirmed **"Johnny fights now"**. See `docs/COMPANION_COMBAT.md`.
- [x] September 29 local interaction: user accepted stepping back/circling to face Judy without Johnny following, followed by both resuming when V leaves ("everything good now"). The bounded gathering state fixes the earlier departure misclassification. All 112 checks pass; installed at 02:45 IST and reload confirmed at 02:46. The accepted live trace is preserved locally; broader obstacle/large-party acceptance remains separate.
- [x] September 29 movement rebuild: fixed the arrival sample/coasting/reverse correction with explicit travel, approach, braking, settled attention and recovery stages. User accepted the rebuilt glance, then accepted the local interaction correction and asked to move on. Recorded Judy finishing her approach/coast before the 0.16-metre social step; facing error reached zero. See `docs/COMPANION_MOVEMENT_DESIGN.md`. Broader obstacle/large-party scenarios remain open below.
- [x] September 29: correct the reported Judy/Johnny glide and repeated-turn case through the movement rebuild and local-interaction fix above. The earlier live handler retained V in `_facingTarget` even with rotation disabled; clearing it stopped the measured turn loop. The later accepted two-companion sequence includes following, approach, settling and local attention. This does not qualify every rig, obstacle or larger-party animation. See `docs/COMPANION_BEHAVIOR.md` and `docs/COMPANION_MOVEMENT_DESIGN.md`.
- [x] September 29: remove the automatic standing turn back to the group's travel direction. The rebuilt controller retains the settled stance after attention; the trace records it and the user accepted the subsequent glance/local-interaction sequence. Keep the small social footstep. Broader group checks remain below.
- [ ] September 29: prevent invitations placing a companion on a road below V. Same-floor navigation/path/clearance checks reject unsafe invitations; attached position is checked before assigning the follower role. Runtime confirms both Johnny roots and Iris on V's floor. The later Johnny invisibility report is tracked separately below; elevated/disconnected-floor visual acceptance remains pending.
- [x] September 29: make fresh Johnny invitations visible automatically. The native phantom controller hid otherwise attached copies. After the permanent preparation was installed and CET reloaded, the user confirmed a newly invited Johnny is visible.
- [x] September 29: report queued invitations separately from completed attachment. Added scoped MCM banner text and one-time ready/failure notifications; late spawn failures are retained in the manager. The user confirmed the post-join confirmation on the fresh invitation; automated checks cover queued text, delayed failure, duplicate notices and save changes.
- [ ] September 29: verify save reload after death with an active party. The reported crash was an unresolved native access violation; retained references and command queries during unload were found and corrected. Death/detach now clears session state and pending invitations without accessing old native components. Installed; crash resolution remains unconfirmed.
- [x] Spawn mod-owned copies of Judy and Panam without changing the role of ambient pedestrians. Judy was visible and followed V in a live save.
- [x] Support multiple characters and duplicate copies in one party. A Judy, Panam, second Judy party spawned and moved in a live save.
- [x] Keep stable side positions as V turns the camera; run to catch up when V runs. Both were observed in the live group test.
- [x] Spawn the nearest companion beside V without bumping V; bring the nearest side position to about 1.5 metres. Measured in-game after the latest spawn.
- [x] Give companions a subtle look toward V, a full body turn and small footstep when V looks at one. The footstep and softer upper-body look were accepted in an earlier live Judy test. On September 29 the user removed the automatic return turn; retain the comfortable stance after looking away.
- [ ] Recheck the latest look, footstep, relaxed stance after looking away, and closer spacing with a group of at least three, including duplicate copies, during walking and running.
- [x] Show each active managed copy on the minimap with a marker that follows it and disappears on dismissal. The game's follower role supplies a green marker per copy: Judy, Panam, and a second Judy showed three distinct markers with our custom pin disabled; dismissing Panam left two. The extra custom mappin and world-widget hook were removed.
- [x] Verify the rebuilt arrival/deceleration path in the accepted two-companion case. The September 29 trace records Judy and Johnny travelling, catching up, approaching, braking and settling; the user accepted the final local-interaction/departure test. Further obstacle, larger-party and duplicate-copy coverage remains below.
- [x] Prevent a second sideways attention step after Judy first repositions. A fresh live test showed one 0.16-metre step, a full turn toward V, and no extra backward move.
- [ ] Make group walking feel like friends beside V across turns, obstacles, sprint catch-up, and stopping. Validate the rebuilt continuous controller across the cases in `docs/COMPANION_MOVEMENT_DESIGN.md`; do not treat a single settled frame as motion acceptance.
- [ ] Decide how companions persist across save loads, fast travel, vehicles, combat, and game reloads; restore or clean them safely.

## Interaction and conversation

- [x] September 29: move the supplied VoiceBench reports, setup notes and ZIPs from Downloads into `ref mods/voicebench-2026-09-29/`, preserving SHA-256 checksums and a move receipt.
- [x] September 29: reduce repeated OmniVoice GPU launch overhead without changing the model, 32-step default or waveform. Bounded FP16 CUDA replay is installed; controlled samples for all three voices and both step counts match the originals byte-for-byte. Twelve shape/voice changes showed no same-shape allocation growth after fixing CUDA stream lifetime. See `docs/VOICE_ACCELERATION.md`.
- [x] September 29: complete a bounded FP8 feasibility test using the coworker's research as a reference. On this laptop the independently authored PyTorch FP8 candidate saved 42–113 ms per repeated 32-step render and about 395 MiB live tensor allocation, but peak reservation did not fall. First-shape comparison was confounded by reference preparation; voice quality is unqualified. Retain FP16 replay in production. TensorRT or production FP8 would require separate evidence, not this small check. See `docs/VOICE_ACCELERATION.md`.
- [x] September 29: make Judy's speech opening more natural. After the occasional right upper-lip distortion, v3 zeroed the added individual upper raisers; the user then identified insufficient opening as the main issue. V4 increases jaw targets for open sounds while retaining closed consonants. The user confirmed **"Natural opening"**; the native receipt confirms v4 and a clean face reset. Other rigs, smiles and emotional performance remain separate work. See `docs/LIPSYNC_REFINEMENT.md`.
- [x] Start spoken replies before the entire response is generated. The installed OmniVoice producer publishes its first phrase before later synthesis. The later Convai stream has live evidence of eight chunks, and September 30's Judy reply was still generating while earlier chunks played. Exact-copy ownership, sequential group playback, native-cursor captions/face and cancellation guards are covered. See `docs/SPEECH_STREAMING.md` for the September 29 local route and the September 30 latency evidence above for Convai.
  - The September 29 local checkpoint passed 146 checks with one unavailable MCM environment check. It used two-phrase read-ahead and fixed quality per utterance; Convai still used complete-turn capture at that historical checkpoint, before `27d6c55` added streaming.
- [ ] Qualify audible phrase continuity and native latency across the local voices, streamed Convai, and mixed F8 groups. Preserve raw voice quality and current ownership guards; individual accepted timing observations do not establish every route's listening quality.
- [x] Establish native speech lip sync driven by the playback cursor for Convai/Kokoro and local OmniVoice. The user confirmed Judy's jaw probe and mouth movement during speech, then accepted the refined local opening as natural. This closes basic motion and the local Judy refinement, with additional face performance and Convai calibration checks retained separately.
  - September 29 speech integration: the live adapter now consumes a reply-owned facial timeline at the actual audio cursor. Convai uses indexed ARKit-61 mouth frames; OmniVoice initially has a simple amplitude-driven fallback. The user confirmed Judy moves her mouth and returns to normal but judged the result too simplistic; replace local fallback as the normal route with sound-specific articulation. The user explicitly asked for our own lip sync for custom voices. Pauses, cancellation, speaker changes and unload cleanup are covered by executable checks. Voice WAV bytes remain unchanged. 132 suite checks passed, one installed-MCM check skipped; an additional early-frame collection check passed.
  - Replaced the normal local route with CPU phonetic analysis and authored native articulation: closures, distinct vowel openings, rounding/pursing, F/V lower lip and L tongue. The initial 17-control, 60 Hz analyser passed (211 cues / 1,825 frames for 30.4 s); the later v4 Judy opening was accepted as recorded above. Missing/failed analysis falls back to the amplitude driver without muting speech. Other rigs, broad articulation quality and expressive face performance remain unqualified.
  - September 29 initial control proof: live read-only inspection found the actual Judy/Johnny rigs and 414 tracks. Built a separately named native speech layer for nine human facial graphs, with 50 additive controls and a tag-scoped initialization hook for owned copies. All nine asset round-trips, exact archive paths and 46 graph/combat/companion checks passed. Installed and hash-verified at 03:40 IST after the user closed the game; launched the EXE and confirmed startup compilation. Fixed the live probe runner, then the user **accepted Judy's two visible jaw movements and return to normal**. Four probe lifecycle checks also passed. This established motion before the later speech integration above; Johnny's visible facial test is separate. See `docs/FACIAL_ANIMATION.md`.
- [x] Export a clean team comparison for the completed RT Ultra / 60 FPS tests: one RESULTS.md and all 15 generated cold/warm WAVs plus Johnny's original. Moved from Downloads into the project at `Cyberpunk-Voice-Benchmark-RT-Ultra-60FPS-2026-09-28/` at the user's request. Audio copies and report links were verified; no interrupted runs are included.
- [x] Repeat cold/warm timing at RT Ultra, user-reported Turbo and a verified 60 FPS cap, with a fixed view. OmniVoice 32/16, Nano and Turbo completed; all workers exited and the game stayed running. Twelve WAVs matched the prior samples byte-for-byte. A separate reduced-memory VoxCPM2 test also completed: 83.82 s cold, 44.38–44.72 s warm, 3.82 GiB peak CUDA reservation; its three 8.8-second WAVs are identical and the worker released normally. This experimental CPU/GPU placement is distinct from the incomplete stock all-GPU attempts. See docs/VOICE_RT60_COLD_WARM.md.
- Deferred by the September 28 engine decision: further VoxCPM2 tuning. The user preferred OmniVoice 32 and disliked VoxCPM2's long pauses. Prior unknown GPU-assert crashes remain unexplained; no further VoxCPM2 work is planned.
- [x] Choose the local voice memory policy: the user explicitly selected one always-warm, shared OmniVoice model, default 32 generation steps with a 16-step option. Keep it resident for the voice service's lifetime; no idle eviction. FP16 CUDA through PyTorch, without TensorRT. This replaces the earlier request to investigate idle unloading.
- [x] Install the hybrid voice route and native manager quality setting: Johnny Silverhand, Judy Alvarez and Panam Palmer use base OmniVoice through the pinned VoiceStudio adapter; other characters retain Convai/Kokoro. All three references rendered on the GPU, the user accepted Judy's local speech, and MCM/Settings has live acceptance. The 32-step default and 16-step option are implemented; the later explicit Convai-for-all switch was also accepted. No further datasets or training requested. See `docs/LOCAL_VOICES.md`.
- [ ] Live-check Johnny/Panam local playback, mixed local/Convai F8 order, 16/32 changes and switching back from Convai to hybrid. These paths have source/render/lifecycle evidence, not full in-game acceptance for each case.
- [x] Prepare Johnny Silverhand's original game recording plus five generated versions of the same line (OmniVoice 32/16, Chatterbox Nano/Turbo and VoxCPM2), with GPU-confirmed latency measurements and resource/requirements notes. All six WAVs were copied without processing and checksum verified. The user subsequently chose OmniVoice 32; the remaining live provider checks are listed above. See docs/JOHNNY_VOICE_COMPARISON.md.
- September 28 voice research history (superseded by the hybrid choice above): Convai text-only transport and several local engines were investigated. The following notes retain their original checkpoint's pending work and production state; the decisions and installation above supersede them. User explicitly authorized GPU use, overriding gpu use.txt. Do not claim every game model has a usable voice reference.
  - Implemented and verified the Convai text-only SDK path with a real isolated reply: no remote audio or microphone capture. Added optional VoiceStudio transport with serialized raw-WAV generation and text-preserving failure handling; production remains on Kokoro pending the comparison.
  - Extracted 21 reference clips and exact transcripts from installed English game archives; checked archive hashes, subtitle IDs, WAV format and clipping. Five characters have benchmark candidates. Recordings, transcripts, saved prompts and weights remain ignored. Listening is still pending; ambiguous 8ug8ear assets were excluded. See docs/GAME_VOICE_REFERENCES.md and docs/VOICE_ENGINE_COMPARISON.md.
  - First comparison generated Ana/Blue Moon with OmniVoice and Chatterbox Turbo/Nano while the game stayed open. The user prefers evaluating recognizable characters, so added two verified Panam references (23 clips total) and moved the listening comparison to Johnny, Judy and Panam. Engine choice and in-game local-voice acceptance remain open; existing Kokoro production is unchanged.
  - Listening feedback: the user rejected Chatterbox and said OmniVoice sounds better. Continue with VoiceStudio/OmniVoice as the leading option; the OmniVoice samples were generated through the exact repository the user shared, not a substitute. Relative preference is confirmed; full voice-quality and in-game local-playback acceptance remain open. Qwen source was inspected as a possible fallback; no Qwen environment or weights were installed.
  - Deferred by the user's latest request: additional datasets and fine-tuning. The earlier Judy pilot used 191 verified recordings (18.8 minutes), with 48 held out; checkpoint 100 was rejected in favor of the base voice. Existing research assets are preserved, but the live integration uses only the three existing verified references and the base model.
    - User rejected Judy checkpoint 100 in favor of base OmniVoice. Paused the planned 250-step pilot for that review; no full-run completion is claimed. The merged checkpoint also rendered through the actual VoiceStudio HTTP service, but it remains excluded from production. Johnny/Panam datasets are ready, not trained. Next compare VoiceStudio's VoxCPM2, with IndexTTS 2.5 as another candidate; keep base OmniVoice as the listening reference.
    - Generated longer Johnny/Judy/Panam samples through VoiceStudio's VoxCPM2 adapter using the same original references, with no added EQ, denoising or voice effects. User says these sound better, making VoxCPM2 the preferred quality candidate. 48 kHz PCM output passed clipping checks; warm complete-waveform generation took 24.85 s for Judy and 37.28 s for Panam. Latency needs improvement before live use. The candidate worker was released; production speech and the running game were not changed.
    - GPU use confirmed for all tested engines. Fresh OmniVoice direct-adapter measurement: a 6.96 s Judy line rendered in 2.77 s at 32 steps, or 1.38 s at 16 steps, once its reference was cached. Peak reservation was 4,336 MiB VRAM. These are engine measurements, not the earlier complete HTTP service timings or in-game acceptance. See VOICE_BENCHMARKS.md for the resource definitions and limitations.
    - User identified OmniVoice as a promising live-chat choice after the speed comparison. Recommend base OmniVoice at 32 steps with a resident model and cached per-character references; retain VoxCPM2 for likeness comparison. The 16-step speed option and full local in-game playback still require acceptance. Production has not switched from Kokoro.
- [ ] Improve Kokoro voice casting after the first expanded group test. User accepted Blue Moon's Emily voice but disliked 8ug8ear and Ana, both using Megan. Seven Megan defaults were replaced and read back from Core; Blue Moon retained Emily. Audit found no added EQ, gain, compression, pitch changes or clipping. Compiled a per-emitter reverb opt-out, awaiting the combined native install. Replacement listening remains open as the user requested cloned voices next.
- [x] Maintain character connections and share one route across duplicate copies. The September 28 group of 8ug8ear, Ana and Blue Moon had three private and three group connections ready before chat; service probes verified retention and scoped dismissal. September 30 moves memory/private preparation earlier to **Invite**, gates actor creation and preserves the prepared page through attachment and the first actual send. See the invitation section above; the persistent player ID is shared across all characters.
- [x] Research and provision the phone-profile expansion, retaining conditional game events separately from established history. The original 75 named phone profiles, two ambient residents and later Johnny/Smasher entries were read back from Core; the representative 8ug8ear/Ana/Blue Moon F8 group was accepted. September 30's corrected separate fields and all-79 dossier review supersede the earlier description format. This marks profile preparation and representative routing, not universal model compatibility.
  - Research/build complete: 75 named phone profiles, 375 original dialogue examples, 765–913 words per named description (median 851), and source/uncertainty notes. Core readback verified these and two ambient residents with Kokoro and `fast-gemma-4-31b-it`. The user confirmed an expanded 8ug8ear/Ana/Blue Moon group replies in turn with the addressed character first. Johnny and Adam Smasher now add two researched manager profiles (79 total); both new Core descriptions, IDs, model and voices were verified. Most individual characters still need live spawn checks.
- [x] Reduce the measured Convai group preparation delay with persistent connections and overlapping preparation while speech remains sequential. The September 28 group measured 4.43s, 3.79s and 1.71s to ready replies with zero connection setup time, compared with its earlier 6–9 seconds per speaker. These are observed provider turns, not local TTS timings or a latency guarantee.
- [ ] Measure current F8 timing and listening gaps after invitation preparation, streaming and local voice integration; include a mixed-provider group. The accepted September 30 ~4.9-second first-send trace is private Judy evidence only.
- [x] F8 composer heading shows only the addressed character's name, exactly like F6. Live heading inspection and the user's three-character round confirmed the addressed-first behavior.
- [x] Preserve typed capitalization in the F6 composer. A scoped OriginalCase hook replaces Codeware's forced uppercase only in our input. The live controller reported OriginalCase and the user confirmed mixed-case typing works. The input was not submitted in this check.
- [x] Fix the missing response to "hey". The managed Alex was reported by the engine as Alena Xenakis; the legacy router did not match her and the bridge was stopped. Added canonical managed identity, Alex/Kerry profiles, a hidden bridge launcher, explicit reply errors and a 40-second timeout. Direct Alex API reply succeeded; the user confirmed a reply appeared in-game.
- [x] Add a native phone composer with per-contact history and replies, using the user-requested separate **Chat** tab and direct conversation flow. The user accepted the layout/typing and subsequently confirmed that histories remain separate across people.
  - September 29: installed prototype `a928adc`; the user's screenshot confirms an 8ug8ear message and reply. Replaced the mixed quest/AI panel with a separate Chat tab, a direct contact flow, complete stored transcript, and a docked bottom composer. UI acceptance is recorded below; launch-only disappearing-history retention still needs its live check. Convai sessions remain separate from display history and nearby NPCs.
  - Follow-up screenshots exposed a detached header and retained quest reply widgets. Applied a live native-widget correction: matching tab typography/palette/underline, hidden quest suggestions with a scoped activation guard, and an inline cyan Enter/Esc placeholder. The user confirmed the corrected tabs and typing are all good. Normal Messages visibility restoration has automated coverage; 18 focused phone checks pass. No restart needed.
- [x] Use a game-styled native text input that accepts typing without opening CET. Basic live text exchange with Convai worked.
- [x] Use native dialogue subtitles for replies and remove the thinking notification. Installed live without restart. The game had Cinematic subtitles disabled; enabled and saved that setting, and the user confirmed Alex's named native subtitle appears without thinking notifications. Only this mod's caption IDs are removed. Long text is paged by reading time until voiced playback supplies timing.
- [x] Support ordinary F6 private text conversations with per-character routing, voiced replies, native subtitles and return to gameplay. Alex and Judy replies, original prompt and mixed-case typing were confirmed live; the accepted separate phone Chat flow is recorded above.
- [ ] Live-check text error/retry, cancellation and playback switches without losing drafts or returning into a stuck screen. Source/adapter coverage exists; ordinary successful conversations do not close these exceptional-path checks.
  - September 28 continuation: wired the manager's voice/subtitle switches into native playback. Muting stops the owned emitter; hiding subtitles removes only this mod's caption; re-enabling joins the current audio cursor. Executable Lua tests pass and the live adapter accepted the patch without reload. Visual switch behavior still needs acceptance.
- [ ] User-deferred microphone check: F7 single-character capture is implemented (press to start, press again to finish), including lifecycle guards. Verify a real microphone conversation when the user elects to test it. Text-triggered Kokoro voice/subtitles were accepted with Alex, and playback-timed rig mapping is now implemented; neither establishes microphone recognition or the full mic-to-reply flow.
- [x] F8 group text: representative expanded group accepted with the addressed or nearest character first, up to two other distinct nearby profiles, listener-scoped context and sequential replies. Duplicate copies remain one speaker. Range-loss and stale-completion handling have executable coverage; group sessions remain separate from private sessions.
  - The 8ug8ear → Ana → Blue Moon test confirmed three replies in order and the addressed-only heading. The final-speaker follow-up policy exists; its optional setting is the current task above. Broader profile, voice and cancellation checks remain separate.
  - Live F8 exposed a silent substitution: addressing unconfigured 8ug8ear selected Alex. Fixed selection to report the addressed character's missing profile; F8 also requires at least two configured nearby speakers. The expanded 8ug8ear → Ana → Blue Moon round subsequently worked. Voice quality remains separate from the accepted turn order.
- [x] Implement the requested F9 group microphone entry and route, retaining F8's audience/order rules. See `docs/GROUP_VOICE.md` for lifecycle and transcript coverage. Audible microphone testing remains deferred.
- [x] Use the same LLM model as the Dawnwalker mod and verify actual IDs/voices. Read-only inspection of Dawnwalker's Anca confirmed `fast-gemma-4-31b-it`; final Core API readback verified that model, exact descriptions and Kokoro voices for all 77 Cyberpunk profiles on September 28. Existing project IDs were retained.
- [x] Give the selected managed companion a focused look and small natural adjustment before Talk; preserve subtle attention for the others. The user accepted Judy's attention step and the later two-companion gathering behavior. Gaze/distance selection and release remain part of the owned-companion controller.
- [ ] Qualify attention for still ambient NPCs without taking over their quest/crowd ownership. Walking-pedestrian stopping is optional by the user's decision and must be safely reversible; the failed role-adoption experiment is retired.
- [ ] Ensure the look and conversation behaviors do not seize quest actors or leave pedestrians stuck. An earlier crowd-role experiment crashed; that approach is retired.

## In-game management and controls

- [x] September 29: add breathing room between the phone's J/L keys and person icons. The live row measures a 16-unit gap instead of 2, with 132-unit action cells and compensating label space. Applied without a restart; the user confirmed it looks fine. The live adapter reads the actual widget tree because private controller fields are not exposed to CET.
- [ ] Investigate intermittent rapid top-to-bottom looping in Phone Contacts if it recurs. Reported September 28; user said it stopped on its own before a trace could be collected. No cause established and no input/layout fix applied.
- [x] Prevent phone J/L actions from also triggering normal game shortcuts. A scoped CET menu-action guard was installed live; the user confirmed J/L work in Contacts and J works normally after closing.
- [ ] Live-check a contact newly unlocked in the same playthrough appearing in Contacts/Chat without a mod update. The installed catalog includes inactive journal contacts and the native list is refreshed on open; it never unlocks quests or contacts for the player. That new-unlock transition has not been observed live.
- [x] Replace the native Codeware popup prototype with MCM's proper settings page. User screenshots verify Characters, Current party and Settings; F4 entry, invitations and the later organized Settings/Memory submenu have live acceptance.
  - User reaffirmed September 28: F5 must provide a Dawnwalker-style manager containing the mod's settings and summon/dismiss controls. Its searchable character catalogue must extend beyond phone contacts to Johnny Silverhand, Adam Smasher, and other installed game character models. Expose available models independently of phone unlocks, support multiple copies, and distinguish researched conversation profiles from models without one. Verify actual records and follower compatibility on owned copies; do not alter quest actors.
  - Built and installed an MCM API v2 provider with multiple copies, profile assignment, native search and persistent OmniVoice 32/16 selection. Model discovery uses 48 records per frame and 18 displayed results. The September 29 checkpoint passed 90 checks including the installed MCM API; September 30's larger installed checkpoint passed 983. Johnny visibility/floor/death concerns have their own entries above. The current manager key is the user's accepted local **F4**; preserve it.
- [ ] Live-check model search, per-copy conversation profile reassignment, character enable/disable and broad Apply/Revert/persistence behavior. Actual invitations and the Convai provider setting already have acceptance; these other controls have source/framework coverage. Keep the requested individual voice selection on the backlog until its intended per-character control is implemented and verified.
- [x] Report actual and pending party copies separately, with invitation state, cancellation/dismissal and attachment confirmation. The manager's runtime queue and repeated live Iris/Johnny/Judy invitations establish the basic path. Duplicate-copy spawning and individual dismissal were also observed in earlier group/minimap tests; full MCM multi-copy manipulation remains a separate live check.
- [ ] Exercise multiple duplicate copies entirely through Current party, including cancellation, reassignment and dismissal, and verify every displayed state against its own actor. Keep settings and runtime synchronized across save/reload boundaries.
- [x] Add custom cyan person-plus/person-minus icons beside the selected contact's message/call controls, using **J invite / L dismiss**. The user confirmed the actions, suppression of the normal shortcuts, in-row feedback while the phone stays open and the later increased key-to-icon spacing. The phone remains keyboard operated; no mouse-click support is claimed.
- [x] Install the expanded 102-entry phone catalog rather than limiting controls to four profiles. It covers all 101 journal contacts plus Misty: 77 mappings to existing character records (including aliases), and 25 explicit unavailable entries for services, drones or unmapped physical characters. Record existence is verified and representative expanded contacts spawned/replied. No quest unlocks are changed.
- [ ] Verify remaining mapped characters' actual spawn/follower compatibility and investigate unavailable physical models such as Delamain drones. Catalog inclusion alone does not establish that every contact is summonable.
- [x] Preserve the requested control roles with the accepted local manager binding: **F4 manager**, **F6 single text**, **F8 group text**, plus phone **J invite / L dismiss**. The reference default remains F5 for the manager; the user's working F4 mapping overrides it locally. F7 and F9 are registered; microphone checks remain user-deferred.
- [x] Use accepted native styling for world text input, phone controls/Chat and MCM; live keyboard typing, navigation and returning from Memory to Settings are confirmed.
- [ ] Qualify remaining mouse/controller navigation, repeated close/reopen and exceptional screen-exit behavior. Phone Chat controller text entry is not implemented; source/framework success does not qualify every input method.

## Updated Dawnwalker reference: 0.5.5 (September 28)

Port the intent to V and Cyberpunk systems; do not assume Dawnwalker APIs, Coen's relationships, or Horde events exist here. Reference archives: `ref mods/DawnwalkerConvai 0.5.5 Scripts*` and `*Multilingual*`. These are requested features, not completed behavior.

- [ ] Blend smiles, blinking and emotion-driven facial reactions with speech and lip sync; avoid competing face animations and restore normal expressions afterward.
- [ ] Accept adjustable native eye contact in the game; retain the accepted
  subtle side glance/full focused look and natural footstep behavior.
  - [x] Implement persistent height and head-strength selectors with unchanged
    defaults, native world-offset semantics, exact look-event replacement and
    movement independence. Source gate: 136 checks passed with installed MCM;
    label-copy follow-up: 31 passed, one environment-dependent MCM check skipped.
    See `docs/COMPANION_GAZE.md`.
  - [ ] Install/activate the new selectors and check their native layout and
    effect while V stands and crouches. The source is prepared; the current
    running game retains the previous gaze modules during lip-sync diagnosis.
- [ ] Optional natural follow-up questions, **default Off** per the user's September 30 correction. In a group, only the final speaker may ask V a follow-up; coordinate turn completion so speakers do not repeatedly reopen the conversation. This is the active task at the top of the file.
- Loot batches and their independent default-On setting have representative live acceptance. Combined battle/loot, Legendary equipment and storage-silence acceptance remain in the September 30 loot entry. Solo-exploration reactions are explicitly user-deferred pending reliable provenance; do not enable them merely to match the reference.
- [x] Discuss the active quest and only objectives revealed in the current save. The user accepted Judy's live objective reply, and the trace confirmed refreshed context for **Freedom**. Hidden/completed branch exclusion and conversation routing are covered by the affected checks. See `docs/QUEST_CONTEXT.md`.
- [x] Battle opening/ending reactions with default-On control. The user confirmed both with Judy; ten-minute cooldown and save-reset behavior have executable coverage. Pending replies wait for autonomous native speech within their original deadline. Combined loot is now implemented with live acceptance still pending in the loot entry; exploration merging remains deferred with its source feature.
- [ ] Retain recent battle context: observed actor names, enemy types and relevant encounter progress. Adapt Dawnwalker's cleared-Horde-wave context only if Cyberpunk provides an equivalent verified event.
  - Current implementation records only hostile NPCs V looks at within forty metres during combat, capped at twelve entities, with optional verified Human/Android/Drone/Mech types. It retains the latest encounter for fifteen unpaused minutes and distinguishes witnesses from companions receiving reported facts. No kill, victory or wave count is inferred.
- [ ] Complete cross-feature acceptance for microphone, mixed-provider group speech, broader facial rigs and gentle distance-based volume. Private F6 and three-speaker F8 text/voice/subtitles are already accepted; duplicate copies remain one speaker. F7/F9 live testing is user-deferred.
- [ ] Ten interface languages with automatic detection and manual selection, English, Simplified Chinese, Traditional Chinese, Spanish, Brazilian Portuguese, French, German, Russian, Japanese and Korean (confirmed in the new reference). Keep interface language independent of conversation voices.
- [ ] Optional multilingual conversation profile pack with separate character IDs and voices supporting 25 languages, including Russian, Spanish, French, Arabic and Japanese. Verify Convai voice capability and preserve the default Kokoro setup.
- [ ] Optional native overhead subtitles above the current speaker, synchronized with actual speech timing. Keep the regular dialogue HUD as the default; retain complete short sentences and avoid unnecessary fragmentation. Updated to the user's September 30 preference, overriding the original Dawnwalker-derived default.
- [ ] Per-character relationship profiles: Auto follows verified relationship history in the current save, On selects a romantic profile, Off selects the ordinary profile. Adapt Anca/Lacra behavior to appropriate Cyberpunk companions rather than copying their identities or flags.
- [ ] When the save verifies multiple relevant relationships and those characters are in group chat, allow character-specific relationship acknowledgement and banter without inventing relationship history.

## Architecture and release readiness

- [ ] Complete a fresh Cyberpunk overhaul guided by the Dawnwalker AI companion philosophy and features. Reuse or port good code when it fits, but do not carry over the old Cyberpunk mod's janky structure.
- [ ] Review the old Convai Cyberpunk mod, the Dawnwalker source, and the supplied `ref mods` archives when implementing each feature; record important compatibility choices.
- [x] Keep the Convai key out of Git and published files. At the user's request it is stored locally in ignored `runtime/convai-key.txt`; the bridge uses their account.
- [ ] Add repeatable diagnostics and real-game acceptance checks for the manager, phone action, text, voice, lip sync, multi-copy lifecycle, and minimap markers.
- [ ] Prepare a distributable mod with clear prerequisites and install instructions after the live feature checks pass.
- [ ] When publishing is authorized, use the user's personal account rather than the work account; confirm the intended account before GitHub or mod-site actions.

## Current setup notes

- Current accepted setup, September 30: native MCM on F4 with organized Settings and a separate Memory page; native phone Chat and J/L contact actions; private F6 and representative three-speaker F8 replies. All 79 researched profiles use the separate Core biography/style/example fields. The user selected Convai for all voices; the optional shared FP16 OmniVoice route remains available for Johnny, Judy and Panam. Invitation preparation checkpoint `9290ab3` passed 983 checks and retained Judy's prepared route into her first send. Natural recall, Forget and the remaining route/UI checks above are still open.
- One persistent player ID serves all saves, characters and channels. Uninvited/unused characters receive no proactive memory setup or seeding. Invite prepares its requested profile and connection before spawning; the first actual player send records contact. Clearing memory requires the user's deliberate per-character or all-character confirmation and retains the ID.
- Subagents inherit the current parent's model and reasoning rather than staying pinned to an earlier model. The user authorized GPU use and explicitly overrode `gpu use.txt`.
- Historical September 28 group/profile checkpoint: original 77 Core profiles verified and installed; the user confirmed 8ug8ear, Ana and Blue Moon reply in turn and the F8 heading names only the addressed companion. All six private/group connections were ready before chat. Seven Kokoro recasts were then installed; their listening check remains open. Johnny/Smasher added two Core entries. At `ffd94a1`, the 58-check manager/local-voice additions were not yet active; subsequent MCM and hybrid installations supersede that state.

- Historical September 28 voice installation: Audioware 1.9.9 and TweakXL 1.11.4 were backed up/installed and native startup compiled. The playback owner handles cancellation, target loss and native-cursor captions; eight WAV slots avoid per-reply restarts. The older REST endpoint returned HTTP 500 for Kokoro voice, while SDK 1.7.0 returned a valid 2.77-second, 48 kHz mono reply plus 49 facial frames. The user confirmed Alex's audio/subtitles. Rig mapping was absent at that checkpoint and was subsequently implemented/refined as recorded above. F7 still opens the microphone only on an explicit start, with a 30-second limit; its live test remains user-deferred.

- Game: `E:\SteamLibrary\steamapps\common\Cyberpunk 2077`.
- Sources: `mod/`, `r6/scripts/CyberpunkConvai/`, `bridge/`, and `characters/`.
- Reference sources: `vendor/reference-convai-github/`, `vendor/reference-dawnwalker/`, and `ref mods/`.
- The game is running for live testing. Ask the user for in-game observations; they retracted Computer Use. When a restart is needed, install first and launch the game EXE for them.
- The follower role already provides a clean green minimap marker per managed copy. The custom mappin experiment added a missing-texture square and proved unnecessary; its game scripts are quarantined under ignored `vendor/unused-game-hooks/`. The save-load crash was caused by CET replaying a stale diagnostic spawn request and was fixed separately.
- September 28 phone recovery: the Lua live preview's path lookup resolved to the contact-row root. Clearing its children blanked the phone. Preview callbacks were disabled through diagnostics, the loader was removed, and the failed helper was quarantined under ignored `vendor/retired-phone-preview/`. User's subsequent screenshot confirmed the list returned. Do not repeat this raw Lua widget-path approach or call `RemoveAllChildren` on unresolved widgets. Typed redscript references are used by the replacement.
- Historical September 28 phone installation: corrected J/L controls, initial 52-entry catalog and deferred spawning until the phone closed. The user confirmed spawning and the journal-conflict fix. The combined update added visible in-phone confirmation, the 102-entry catalog, canonical companion identity and reply errors/timeouts; native compilation, Lua and protocol checks passed. September 30 now begins memory/connection preparation immediately in the open phone while actual spawning still waits for gameplay. The key remains ignored in `runtime/convai-key.txt`. Alex/Kerry were the first added profiles; later native voice, subtitles and Judy lip-sync checks are recorded above.
- Input testing helper: `scripts/Test-GameInput.ps1` restricts input to the verified game process, supports held keys, releases in `finally`, and captures the game viewport. Background PrintWindow capture worked; background window-key messages did not close the pause menu. Foreground held-T injection was delivered, but the game was in Settings, so phone opening was not validated. User switched back to manual game testing; do not send further input without renewed authorization.
