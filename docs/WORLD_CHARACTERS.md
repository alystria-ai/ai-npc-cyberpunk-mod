# Talking to the game's own characters

Written 2026-10-18 on branch `world-talk` (from `main` 97509e0b). Unit-tested and compiled (`scripts/Compile-Redscript.ps1`); not merged, not installed, not seen in the game.

## The decision

Until now the rule was that the mod never touches a character the game placed, apart from a conversation with an ordinary NPC (docs/WORLD_COMPANIONS.md): a story or named character (the game's own Judy, Jackie, Panam, Rogue) got nothing at all, and the talk keys said "does not have a conversation profile configured yet".

The user changed that rule on 2026-10-18: *"Add a feature to be able to talk to characters from the game world as well. ... We don't need to mess with those characters too much: just drive the lip sync and emotions based on the expressive emotion settings. No need to mess with their idle settings, look-at settings or gesture ones. Actions support will not be there for these characters either. We only want to drive their face and audio when the player talks to them."*

So: the game's own named characters can be talked to where they stand, with their own profile, voice and memory. The mod drives their voice and their face while they speak. It drives nothing else.

## What a player can do

Face the game's own Judy (or Jackie, Panam, Rogue, or anyone on the roster) and use the talk keys, text or voice. She answers in her own voice, from her own body, with her lips moving to the words and her face showing the feelings she marks (the feeling tags are always on and need a local voice). Her memory is the same as our Judy's: one profile, one memory.

Settings > Conversations > **Talk to story characters** (off by default; turn it on to use this). It takes effect for a character that spawns after the change, so reload the save after switching it.

## The policy

| Question | Answer |
|---|---|
| Who is talkable | A character the game placed (not our copy, not another mod's) whose record or display name is on the roster (`characterCatalog.resolve` with `story`), while the setting is on. Predicate: `convaiWorldPolicy.story(npc)` in `mod/init.lua`. |
| Who is not a story character | Everyone else the game placed. Since 2026-10-22 a quest-bound or story-bound person with no roster profile (a `q###`, `sq###` or `mq###` record, a Main or Side quest flag: the receptionist in a main quest's building, the Afterlife bouncer) is not refused any more: `characterCatalog.resolve` gives every such person an archetype conversation (`fallbackKey`: the archetype their other facts name, else a resident of their gender, with the record name picking the kind: worker, corporate, nightlife, Dogtown ...). They are still `protected` for every other system, and the game's own checks guard the talk (`convaiWorldTalk:refusal` with `idle`, the "busy right now" notice): V in a quest conversation, a call or a scene (tier 3+), the person in a scene dialogue, a fight, an injury, a ride, or a commanded AI that is not standing at a workspot (a post the quest gave them is not a scene). Only a child, a machine or animal, or a body whose gender cannot be told ends with no profile, and the notice says so. Our own copies and another mod's characters keep their own rules. |
| No profile, in words | `talk-no-profile`: a roster character while Talk to story characters is off ("{name} is a story character. Turn on Talk to story characters in Esc > Mods."), Talk to ordinary NPCs off, a child, a machine or animal, a body with no readable gender; any other case keeps the old "does not have a conversation profile configured yet" line. `convaiUnprofiledNotice` in `mod/init.lua`, the reason from `characterCatalog.noProfileReason`. |
| What is driven | The reply's voice, played from the character; its subtitle; its mouth (lip sync) and its face (the blended emotions and the blinks that go with speech), through the same writer as every other speaker. Nothing is written before the reply is heard, and the face is released the moment it ends. |
| What is never touched | Look-at and gaze (`beginFocus` refuses a story character, so no hold, turn, chest twist or eye contact), bark muting, idle and gesture animations, workspots and seating, movement, follow, party, vehicles, actions (follow, fight, drive, leave offers), tactics and perception, attitude, equipment and stance, the scanner name, adoption and spawning. It stays `protected` for every other system. No `ConvaiBeginFocus`, `SetAttitude` or AI command is ever sent for it. |
| Actions | None. A story character is not a party member: no follow, fight, drive or leave offer is captured for its turn, and it is not even told what it cannot do (`sendRequest` and `microphone.captureActions` skip `gameplayActions.capture`). |
| Group chat | Private talk only. A group key aimed at a story character builds the round from the characters with V, as if V aimed at nothing. |
| Auto-connect | Unchanged: looking at a character with a profile pre-opens a bridge connection (no game-side effect), so the first reply of a story character has no connection wait either. |
| When talk is refused | See the next section. |

## When the mod stays out (the guard)

The guard is `mod/world-talk.lua`, a read-only module (`classify` is pure). It asks "may V talk to this character right now?" and refuses when the game is in charge:

| Reason | Read from |
|---|---|
| `gone` | detached or dead (`IsAttached`, `IsDeadNoStatPool`) |
| `hub` | V is in a quest conversation, a phone call or a scene of her own: the player-side sample of `mod/battle-observer.lua` (`dialogue`, `call`, scene tier 3 or above; tier 2 is staged gameplay, V walking freely where the game has staged its people, such as Viktor's clinic or Misty's shop, and does not refuse by itself; `choices`, a dialogue choice on screen, counts only when the tier is unknown, because the game also shows its "Talk" prompt on an idle ripperdoc, vendor or fixer as a choice). The refusal log line then lists these facts |
| `dialogue` | the character is in a scene or quest dialogue (`IsEntityInDialogue`) |
| `driven` | a scene or quest commands its AI (`not IsOnAutonomousAI()`) |
| `combat` | the character (`NPCPuppet.IsInCombat`) or V is in a fight |
| `hurt` | injured, defeated, unconscious, stunned or ragdolled (the game's five status tags) |
| `vehicle` | mounted in any vehicle (`GetMountingFacility():IsMountedToAnything`); stricter than "as a driver" on purpose |
| `unreadable` | a read failed: fail closed |

**Johnny Silverhand is a projection, not a person the game stages** (2026-10-21, a player's "busy right now" with no quest running). The game's own scenes, workspots and mounts command his AI and seat him in V's car in ambient moments, so for `johnny-silverhand` (`M.PROJECTIONS` in `mod/world-talk.lua`) `driven` and `vehicle` do not refuse. Everything that says the game has the floor still does: V in a quest conversation, a call or scene tier 3 or above (`hub`), Johnny in a scene dialogue (`dialogue`), a fight, an injury, and a missing body. His face follows too (2026-10-23, the owner's 0.2.9 test: in the passenger seat of V's car his reply was heard but his lips did not move, standing they did). The face-side commanded-AI refusal (`skipped:driven`, `Face.reds` `TalkRefusal`, and the Lua autonomy check `luaActorSafe` in `mod/facial-playback.lua`) kept his mouth shut because a mounted passenger's AI is commanded. For a projection alone the talk start now tells the puppet so (`ConvaiFaceProjection(true)`, `convaiFaceRequestFor` in `mod/init.lua`; the field is read only by `TalkRefusal`, once per talk start) and the writer skips the autonomy read for him (`M.storyProjection`). His own scene dialogue (`skipped:dialogue`), a fight and an injury still leave his mouth to the game. Face only: no seat, workspot, AI command or animation is touched and nothing runs per frame. The face graph is still prepared at his spawn, so Talk to story characters has to be on before the save loads.

`IsEntityInScene` is deliberately not read: it stays true in ordinary gameplay (docs/WORLD_COMPANIONS.md, `mod/battle-observer.lua`), so it would refuse every character that stands at a workspot.

The same test runs at five moments, and the guard only ever reads:

1. **The talk key** (text or voice), fresh read: a refusal shows the notice "{name} is busy right now." (`talk-busy`) and one probe-log line, `World conversation refused: profile=... reason=... facts[gone=... hub=... dialogue=... driven=... combat=... playerCombat=... hurt=... mounted=...] (classify=... quest=... record=...)`: the reason and every fact behind it (for a hub refusal also V's dialogue, choice, call and tier flags). Written only on a refusal, from the key press; the support report carries it with the rest of probe.log. Nothing was started.
2. **A voice recording** (`targetValid`, polled by the microphone): a refusal cancels the recording.
3. **Redscript, at the start**: `ConvaiFaceRequest` runs `TalkRefusal`: a dialogue and a commanded AI refuse the face (`skipped:dialogue`, `skipped:driven`). The quest flag and a quest-named record do not refuse a named character, because they are what it is, not a scene.
4. **A reply about to begin** (`speech.start`): a scene or fight that began after V asked drops the reply before anything is heard or shown (`World conversation ended: ... (before the reply began)`).
5. **A reply that is playing**, about twice a second (the answer is held 0.4 s per character): the reply is retired (`retirePrivateReply`): voice, subtitle and face stop and the bridge request is dropped. `speech.stop` then calls the face reset (`ConvaiFaceReset`, `speech_owner` back to 0), which hands the face back to the game's own animation. A character that detaches or dies mid-reply ends the same way through the existing target checks.

Walking away does not end a typed reply (the voice plays from the character, as for every NPC); a recording ends when V is more than 12 m away.

## The face

A running `face_rig` cannot change its graph (measured, docs/FACIAL_ANIMATION.md), so the graph is chosen at the character's spawn. `Face.reds` (`ConvaiFaceService.OnWorldInitialize`) now has one more step, `PrepareStoryFace`, for a record in `NamedRecords` (the roster's records, generated from `assets/facial/controls.json`):

- The preparation is the one a spawned character gets (`PrepareSpawnedFace`): the **gated crowd copy** when the character runs one of the four crowd graphs (Jackie: `man_big_sermo`), and the **companion graph** our own copy of that character carries on Judy's photo-mode graph or the paperdoll pair. Anything else is `unsupported-graph:<path>`: the voice and the subtitle still work, and the log says why (`Face request: ... status=...`).
- The speech layer sits behind a switch that stays closed until the mod voices that character (crowd copy: one switch and one compare more than vanilla; companion graph: the layer is always evaluated, with `speech_owner` at 0 it is exactly the vanilla output). The game's scenes and idles feed the vanilla chain unchanged, so the character's appearance and face are never altered. Nothing is rebuilt, no appearance change is scheduled, no shared resource is patched.
- It runs only while the service's `m_storyTalk` is on. `facial-playback.applyStoryTalk` hands the setting over at start-up and each time a world is released, so a save reload picks a change up. It is on by default in redscript, so the feature works even if the hand-over fails.
- **A look change after the spawn** (a quest script, or another mod swapping the character's model or outfit): the rebuild replaces `face_rig` with the vanilla graph again, so the face is prepared again by the same rules (`OnReassemble`, `PrepareGameFace`; `docs/FACIAL_ANIMATION.md`, "October 19: a replaced model"). Until 2026-10-19 such a character stayed silent-faced and the log read `status=stale:...` with every counter at zero (the game's own Judy in her apartment, a 0.2.0 report). The same section lists every status the log can show and what each means.
- After the screen-face step (the Delamain add-on's screen NPC is a named character on a crowd graph and needs its own slot) and before the "not a crowd graph" return.

Emotions: nothing new. The reply's emotion timeline (the emotion tags, always on since 2026-10-20, `bridge/expression-timeline.mjs`) is written by the same writer as for any speaker (`facial-playback.lua`, `applyFeature`). Two differences for a story speaker, both through `M.storyEntity` (set on the key press for that one entity):

- The writer's "is this face safe to write" check (`safeExpressionActor`) uses the Lua checks without the broad scene flag (autonomous AI, dialogue, combat and injury stay). The native check reads the scene flag, so it is not used for this speaker.
- The idle writer (blinks, resting face, listening and thinking faces) stays companion-only (`owns`), so a story character's face is written only while it speaks.

## Cost

- Nothing runs for a story character until V talks to one. `onUpdate` is untouched (tested).
- The key press: one read of the character and V (about ten native calls), plus the profile lookup. A recording poll and a playing reply re-ask at most twice a second.
- A reply with no story character: `speech.update` makes one function call per frame while a reply is playing (the guard returns at its first line when no story character is the speaker). No new per-frame work otherwise.
- At spawn: one record read and one array lookup per NPC spawn (the callback already ran for every NPC); a roster character additionally gets its graph prepared once.
- A roster character on a non-crowd graph (Judy) runs the companion graph's speech layer ungated for as long as it exists. That is about 110 extra float-track nodes per such face, and only the few story characters in view have it. Measure with the perf probe (live check 5).

## Edge cases

- **Our copy and the game's Judy side by side.** Both talk as Judy: one voice and one memory. Our copy is a party member; the game's is not and stays where it is.
- **Quest-named records of roster characters** (`Character.mq012_stud`, `q101_spider_murphy` and so on, all in `NamedRecords`): talkable and prepared like the rest.
- **A character who is not on the roster** (any other story NPC): the old notice, nothing started.
- **A roster name on an unnamed NPC.** The roster also matches by display name (as for a spawned character); an NPC whose display name is exactly a roster name talks as that profile.
- **Setting off.** `profileIdentity` gives no profile again, `convaiWorldPolicy.story` is false, nothing is prepared at spawn after the next reload. Exactly as before this feature.
- **Module missing** (`world-talk.lua` failed to load): the feature is off whatever the setting says.
- **Scene starts mid-reply.** See the guard, moment 5. **A cutscene that takes the speaker** (the face write stops being allowed): the writer is blocked and the guard retires the reply.
- **Crowd-face mode `off`** (the FPS measurement switch): no face is prepared, a story character talks with voice and subtitle only.
- **Mid-session toggle.** Turning the setting on mid-session lets the talk through at once; a character that already spawned has no prepared face, so it talks without lip sync until the save is reloaded (the log says `Face request: ... status=skipped:named` or `unprepared:`).

## Files

| File | Change |
|---|---|
| `mod/world-talk.lua` (new) | `classify` (pure), `read` (native reads), `new` service with a 0.4 s hold per character and `reset` |
| `mod/init.lua` | `profileIdentity` passes `story`; `convaiWorldPolicy.story`; `beginFocus` refuses a story character; `selectConversation` (group aside, refusal, `primary.story`, `convaiStory`); recording validity; `speech.storyGuard`; `applyStoryTalk` at start-up and session release; resets |
| `mod/character-catalog.lua` | `resolve`: `actor.story` lets the roster profile resolve for a world character; no other change |
| `mod/speech.lua` | two hook points (`M.storyGuard`): before a reply starts and while it plays |
| `mod/facial-playback.lua` | `applyStoryTalk`; `storyEntity` (the writer's safety check without the scene flag for that speaker) |
| `mod/manager.lua`, `mod/manager-ui.lua` | the setting `storyConversations` (off by default; a missing key counts as off), its row and help text |
| `mod/notices.lua`, `docs/NOTIFICATIONS.md` | the `talk-busy` notice |
| `r6/scripts/CyberpunkConvai/Face.reds` | `m_storyTalk`, `SetStoryTalk`, `StoryTalk`, `PrepareStoryFace`, the story branch of `TalkRefusal` |
| `localization/en.json`, `mod/locales/*.lua` | three strings, 15 locales |
| `packaging/release-plan.json`, `scripts/development-files.json` | ship and dev-install `world-talk.lua` |
| `bridge/world-talk.test.mjs` (new), `bridge/world-policy.test.mjs`, `bridge/manager.test.mjs` | tests below |

Installing needs a CET reload for the Lua and a game restart for the reds. The face for a character is prepared when it spawns, so reload the save after installing.

## Tests

- `bridge/world-talk.test.mjs`: `classify` for every reason, the order and the fail-closed rule; `read` against fake natives (each reason, each injury tag, V's hub, call, scene tier and combat, a missing native, and `IsEntityInScene` never read); the service hold, reset and bound; the catalog (`story` resolves a roster record for a world character, never falls back for a story-bound one); the real `profileIdentity` and policy (the game's Judy and Jackie talk, a quest goon, a pedestrian, our copy and another mod's Judy unchanged, setting off, module missing, an unreadable entity); `beginFocus` (no look-at, no bark muting); the speech guard (retire while playing, drop before it begins, not for anyone else); wiring (group key, no gaze, the recording guard, the speech and face-writer hooks, nothing in `onUpdate`, no write to the character, no other system takes the story flag); `Face.reds` contracts (the order of the steps, only roster records, the same preparation as a spawned character, no rebuild, the talk-time guard); packaging, notice, locales and docs.
- `bridge/manager.test.mjs`: the setting (default, row, saved Off, booleans only).
- `bridge/world-policy.test.mjs`: the world rules, with the named-character expectations updated.
- `scripts/Compile-Redscript.ps1` compiles `Face.reds` against the game's script cache.

## Live check owed (needs the Scripts install, a game restart and a save reload)

1. Stand next to the game's own Judy (or Jackie, Panam, Rogue) where she is in the world (a local voice speaks, so the emotion tags are asked for). Press the text key and say hello, then the voice key. She answers in her voice from her own body. `probe.log` has `World conversation: profile=judy-alvarez (voice and face only)` and `Face request` shows `prepared:...` (or says why not). Her lips move and her face shows the feeling. The scene tier does not change.
2. While she talks, nothing else of hers changes: she does not turn to V, her idle or work animation goes on, no hold, no bark muting beyond what she says, no gesture. `probe.log` has no `Focus ownership` line for her and the scanner still shows her normal name.
3. Walk away and wait: the reply ends with her face going back to her own animation (no frozen mouth, no stuck expression). Start a second reply and trigger a fight or let a quest scene start: the reply stops, the log says `World conversation ended: ... reason=...`.
4. Face a quest character who is in a scene or a dialogue choice hub, or sits in a vehicle: the talk key shows "{name} is busy right now." and nothing starts. Face a quest NPC with no roster profile: the old notice.
5. FPS and latency: the perf probe shows no new per-frame row, and with a story character in view the frame time is within noise of before (the ungated speech layer on a photo-mode graph is the only standing cost).
6. Settings > Conversations > Talk to story characters Off (the default), reload the save: Judy gets the old notice again.

If the key refuses everywhere with `reason=driven`, `IsOnAutonomousAI()` is false for idle story characters in the world (not measured before); send the log line.
