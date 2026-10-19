# Characters spawned by another mod

Written 2026-10-17 on branch `spawned-characters`. Phase 1 is built and unit-tested there. Phase 2 (group chat, and battle and loot reactions) is built and unit-tested on branch `spawned-phase2`, which starts from phase 1. Neither phase has been merged or installed, and nobody has seen either in the game.

Characters the game itself placed (the real Judy, Jackie, Panam) are a different case: they talk with voice and face only, see [WORLD_CHARACTERS.md](WORLD_CHARACTERS.md) (2026-10-18). A spawned character gets the same talk, profile, voice, memory and lip sync, plus eye contact while it talks; a game-placed one gets no gaze.

Players often use a spawner, another mod or tool, to put characters into the world: Judy, Panam, a ganger, a custom NPC. That mod owns the character's body. It decides where the character goes, how they follow, what they wear and what they do in a car. This document sets out what our mod does with such a character. The short version: they can talk with their own profile, voice and memory, and their face moves with the voice. Nothing of ours moves them.

**A spawned character that has no profile** (Rebecca from Edgerunners, from a character mod) does not have to talk as an ordinary person: the player can make a profile for it in the character editor (2026-10-19, [CHARACTER_EDITOR.md](CHARACTER_EDITOR.md), "Your own characters"). `characterCatalog.resolve` finds it by record or display name after the roster and before the archetypes, so a roster profile still wins; it talks by text and voice and joins group chat like any spawned roster character, with Mistral or Local AI (with Convai it stays an ordinary person and one notice says why).

## Before this branch

A spawned Judy was treated as the protected story Judy.

- `profileIdentity` in `mod/init.lua` set `world = managedKey == nil`. Any NPC that was not our own copy counted as game-placed.
- `characterCatalog.resolve` returns nil for a roster match when `world == true`. A spawned Judy therefore got the notice "does not have a conversation profile configured yet".
- `Face.reds` skipped every entity managed by the dynamic entity system in `OnWorldInitialize`. `ConvaiFaceReady` and `ConvaiFaceRequest` refused managed entities without our companion tag. So even an ordinary-looking spawned ganger had no lip sync.

## Recognition

The test is generic and works at engine level (`mod/spawned-characters.lua`, `ConvaiFaceService.SpawnedElsewhere` in `Face.reds`).

1. **Managed by the shared dynamic entity system** (Codeware's `DynamicEntitySystem.IsManaged`). The game never creates characters through that system. Story, quest, community and crowd actors come from the world and its own spawners, so a managed entity was always made by a mod.
2. **None of our own tags.** Every tag we put on our spawns starts with `CyberpunkConvai`: Companion, Holocall, PartyVehicle, SeatDevice and GestureDevice. In Lua, the two NPC tags are checked by name first, then the tag list is read for the prefix. Redscript reads the tag list.
3. **Not quest-marked** (`IsQuest`). This check is Lua only. A quest mod's actor keeps the usual rules for game characters. On the face side, a quest marking refuses the talk-time face write (`TalkRefusal`, spawned branch).

No other mod's tag, record prefix, template path or name is ever matched. A spawn from any spawner that uses the system is recognised the same way.

**Limits:**
- A spawner that creates NPCs some other way (the older entity spawner or the prevention spawn system) is not recognised. Its characters look game-placed and stay under the world rules: an ordinary NPC can talk, a named one is refused.
- A spawner that turns a game-placed NPC into a follower (the reference spawner can do this) leaves that NPC unmanaged. It correctly stays a game character: the story NPC gets nothing.

**Cost:**
- Lua reads once per entity and caches the answer by entity hash. The cache holds at most 256 entries and is cleared on a session release and at shutdown. It is asked only from `profileIdentity`, the policy and the focus start, never per frame.
- Redscript asks once per entity build, the same cost as the old tag check in `OnCompanionExtract`, and once per conversation. The answer is kept on the puppet as two Bool fields.

## Policy table

| System | Spawned character | Where it is decided |
|---|---|---|
| Talk: composer, microphone, talk key | Yes, a conversation the player starts | `profileIdentity` (`world=false`, `spawned=true`) |
| Profile | Roster match by record, then by display name (a spawner's own TweakXL record still matches by display name). A story-bound record that is not on the roster is classified by its other facts, else as a resident. Never a child. | `character-catalog.lua` `resolve` |
| Voice and memory | Keyed by profile, so a spawned Judy shares Judy's voice and save-bound memory with our Judy copies. Archetype and resident profiles are session-only, per entity, as for any world NPC. | unchanged |
| Lip sync and face | Yes. A gated crowd copy on the four crowd graphs. On other graphs (Judy's photo-mode graph, the paperdoll pair) the companion graph that our own copy of that character carries. Prepared at spawn and again at every appearance rebuild. | `Face.reds` `PrepareSpawnedFace` |
| Eye contact during a conversation | Eyes and head only: no hold command, no turn, no chest twist | `beginFocus` passes `keepAI`; `Engagement.reds` |
| Bark muting during a conversation | Yes, as for any talk target | `beginFocus` |
| Passive glance (V looks without talking) | No, as for ordinary NPCs | `updateGaze`, unchanged |
| Scanner name (`npc-names`) | No. `protected` is true, so the spawner's or the game's name stays. | `convaiWorldPolicy.protected` |
| Tactic target | Only when tagged and it is hostile and in combat, never aimed or nearest | `companion-marking.lua`, via `protected` |
| Gestures, seating, idle flavour | No. They would fight the spawner's poses. | party only, unchanged |
| Follow, formation, catch-up, teleport, lifts | No | party only |
| Vehicles, convoy, chauffeur | No. A spawned passenger in V's car occupies its seat, and our seat list respects that (the native seat read reports an occupant). | party only |
| Equipment, stance, weapons, attitude | No. The spawner may already change the shared record's weapons. | party only |
| Invite, adopt, dismiss, delete | Never adopted. Our invite always spawns our own copy. | see below |
| Follow, leave, drive or fight offers in conversation | No. Offers need a party entry. | unchanged |
| Group chat | Yes (phase 2, built): a spawned character (roster or generic) joins as a speaker after V's companions, whoever V faces, never as a party member. | `selectConversation`, `convaiSpawnedPeople.nearby`, `group-chat.lua` `choose` |
| Turn-context party ("Also with V") | Yes (phase 2, built): the spawned members of the current group round, with no activity | `turn-context` `party` callback in `mod/init.lua` |
| Battle and loot witnesses | Yes (phase 2, built): near V at the start of a fight or at a pickup, friendly, with an enabled roster profile; they may speak the reaction and are named by profile in the battle context | `convaiSpawnedPeople.watch` and `reactionRows`, `reactionPeople` |
| Offers about our party (leave) from a spawned speaker | No | `leaveOffer` in `mod/init.lua` |

## Lips did not move (live result 2026-10-17) and the fix

**Symptom.** The user spawned Jackie and Judy with a spawner. Both talked with their own voice and identity, gaze and follow were fine, and the lips did not move. `probe.log`:

```
Conversation result: ... face=false/prepared:man_big_sermo                    (the spawned Jackie)
Conversation result: ... face=false/prepared:player_woman_photomode_sermo     (the spawned Judy)
Conversation result: ... face=true/prepared:woman_average_sermo               (our own Alex, for comparison)
```

**The graph names were right.** Jackie's record uses the big-man crowd graph (`man_big_sermo`), and Judy's own face graph is her photo-mode graph, the one our own Judy copy carries. A "man_big for a woman" was a misreading: that line was Jackie. The status said `prepared` because the first build was prepared correctly. `face=false` came from `ConvaiFaceReady`, which compares the live `face_rig` graph with the one we prepared.

**Cause.** The spawner creates the character from a record, then immediately asks the engine for an appearance change (`ScheduleAppearanceChange`, with a "cycle" or a saved look). The rebuild creates a new `face_rig` with the vanilla graph. Its extraction (`Entity/Extract`) names no entity: entity ID 0 and no entity part (measured earlier for a companion's rebuild, `docs/FACIAL_ANIMATION.md`, the Johnny trace). `OnCompanionExtract` stopped at the managed lookup, nothing prepared the new face, and the stored path no longer matched. No archive of the spawner changes Judy's or Panam's face graph or rig: the Judy facial fix archive holds one new `.app` that only an `.xl` patch (ArchiveXL, not installed) would apply, and the Judy and Panam body revamp archives hold meshes and textures.

**Fix (`Face.reds`).** The rebuild's own entity is named by the `Entity/Reassemble` event, which Codeware fires after the builder extracted the new components and before they join the entity and initialize (Codeware 1.20.5, `EntityRequestComponentsHook`). The two halves meet there:

1. `NoteRebuild` (in `OnCompanionExtract`, only after a spawned character was ever seen, only for an extraction with no entity ID, no entity part and an appearance): the `face_rig` clones are noted, weakly (at most six, oldest out), with a key for the entity template (`ResRef.GetHash` of the builder's template path, read from the template resource, not through the wrapper that dereferences it unchecked).
2. `OnReassemble` (registered once for `NPCPuppet`, early exits first): for an entity that is spawned elsewhere (managed, none of our tags), every note of its template (`npc.GetTemplatePath()`) is prepared by the same `PrepareSpawnedFace` as at the first build (the gated crowd copy, or the companion graph for Judy's photo-mode graph), and the puppet gets the status and graph path of the newest. A game character, our own copy and another template are never matched.

**Status line.** `ConvaiFaceStatus` now says `stale:<graph the face runs now> noted=N claimed=N reassembled=N unmatched=N` when a prepared face runs another graph. `ConvaiFaceRequest` returns it, so the log gets a `Face request: ... status=stale:...` line at talk start. If the lips still do not move after the fix, that line says where it was lost: `noted=0` (the extraction was not seen as expected), `reassembled=0` (the event did not fire), `unmatched>0` (the template keys differ), or `claimed>0` with a `stale:` graph (the clone the engine used was not the one we prepared).

**Cost.** No per-frame work. Without a spawned character: one `Bool` read per extraction that names no entity (rare) and one script call per NPC reassembly that returns at its first line. With one: the same plus, per rebuild of anything, one pass over the appearance's components (once, for an extraction with no entity part), and per NPC reassembly one native managed lookup.

**Live check owed (needs the Scripts install and a game restart).** Spawn Jackie and Judy with the spawner, wait a few seconds for the spawner's own appearance change, and talk to each by text. `probe.log` must read `face=true/prepared:man_big_sermo` for Jackie and `face=true/prepared:player_woman_photomode_sermo` for Judy, and the lips move. Then change one's outfit with the spawner and talk again. Our own Alex must still read `face=true/prepared:woman_average_sermo`. If a line reads `face=false/stale:...`, send the whole line.

**Not covered.** Our own companions' appearance rebuilds are untouched (their spawn picks the final appearance up front), and a spawned character's rebuild that arrives with an entity ID (none seen) goes through the existing managed path.

**Amended 2026-10-19 (branch `fix/face-replaced-model`).** The two exclusions above are gone: the same note-and-claim now also prepares the rebuilt face of our own copies (companion graph) and of the game's own characters (the story or crowd rules of their spawn), `m_spawnedSeen` became `m_watchRebuilds` for the noting (it also switches on for our copies and for prepared world and story NPCs), and the counters in the `stale:` line are split per kind and carry `events=`. The report that showed the gap: a game-placed Judy, `stale:` with every counter at zero. Details, the status table and the log fields: `docs/FACIAL_ANIMATION.md`, "October 19: a replaced model".

## Invite and party

- **Manager or phone invite of the same character.** Our invite spawns our own managed copy, as always. A spawned Judy and our Judy can stand side by side. Both talk as Judy, with one voice and one memory. Only one conversation runs at a time. A player who wants Judy to follow with our systems invites ours. A player who wants the spawner's Judy keeps hers, and she still talks.
- **Adoption is never allowed.** Taking the spawner's character into our party would make two mods command one body. The world-NPC adoption path stays disabled, and `convaiWorldPolicy.spawned` is the predicate to refuse it if it ever returns.
- **Optional notice (phase 2).** When the player invites a profile they talked to through a spawned character in this session, say once that another copy is already here. We cannot list another mod's entities without its tag, so only the talk cache can know this. Low value: build it only if players ask.
- **Dismiss and delete** act only on our own entries. A spawned character is never in `companions` state.

## Edge cases

- **Save and load.** The reference spawner spawns with persistence off, so its characters are gone after a load, and "respawn all" creates new entity IDs. Our Lua cache is cleared on session release, and new IDs are read afresh. Memory is keyed by profile, so a respawned Judy remembers the previous talk.
- **Despawn mid-conversation.** This goes through the existing talk path. The focus holds a weak reference and ends on `IsAttached` or `IsDead` checks. `ConvaiFaceReady` fails on a detached puppet, so no face write lands. Nothing of ours holds the entity alive.
- **Duplicates.** A spawned copy and our copy of one character share a profile, as above. Group chat tracks speakers by entity (a body is never two speakers, and the round's rows, gestures role and leave guard are all by entity). It also keeps one voice per profile in a round, because the bridge keys a round's audience, memory and heard lines by profile. So with our Judy and a spawned Judy side by side, the addressed one speaks and the other is skipped, and our own copy wins when neither was addressed (see "Phase 2").
- **Appearance changes.** A spawner rebuilds the appearance (an outfit change, and a "cycle" right after it spawns someone), which replaces `face_rig` with the vanilla graph. Phase 1 assumed `OnCompanionExtract` sees such a rebuild as a managed build. **It does not** (live result 2026-10-17, see "Lips did not move" below): the extraction of a rebuild names no entity. The fix is the note-and-claim pair described there.
  - A rebuild during a conversation briefly fails the ready check until the rebuild is claimed, then the face resumes.
  - The rebuild is not ours, so there is no flash risk from us.
- **Car.** The spawner can seat its followers in V's car and drive. We send no hold, so talking to a seated spawned character does not fight its mount. Eye contact uses eyes and head only.
- **Combat.**
  - The spawner's followers fight on V's side by their own attitude group.
  - Our tactic never picks them except as a tagged hostile in combat, for example after the spawner set them hostile.
  - A spawned character that fights against V is still named as an opponent when V looks at it, by the game's own display name (unchanged). Phase 2 makes a friendly spawned character a possible witness (see "Phase 2").
- **Crowd-face mode `off`.** Spawned faces are not prepared either. This is the FPS measurement mode, and a spawned character then talks without lip sync.
- **A spawned quest-record crowd body** (for example a q-numbered ganger) gets the gated crowd graph. The roster and quest-token filters do not apply because the player chose the model.

## Files changed (phase 1, this branch)

| File | Change |
|---|---|
| `mod/spawned-characters.lua` (new) | `classify` (pure), `read` (native), `new()` service with a bounded per-entity cache and `reset` |
| `mod/init.lua` | Loads the module into the global `convaiSpawnedCharacters`. `profileIdentity` sets `spawned` and `world=false` for it. `convaiWorldPolicy.spawned`; `protected` is true for spawned characters. `beginFocus` passes `keepAI`. Cache reset on session release and shutdown. |
| `mod/character-catalog.lua` | `resolve`: spawned story-bound fallback to an archetype or resident, using the actor's body type when the facts have none |
| `r6/scripts/CyberpunkConvai/Engagement.reds` | `ConvaiBeginFocus(npc, opt keepAI)`: no hold, turn or chest weight with keepAI |
| `r6/scripts/CyberpunkConvai/Face.reds` | `SpawnedElsewhere`, `PrepareSpawnedFace`, `m_crowdGatedPaths`, spawned branches in `OnCompanionExtract`, `OnWorldInitialize`, `ConvaiFaceReady`, `ConvaiFaceRequest` and `TalkRefusal(npc, opt spawned)`. NPCPuppet fields `m_convaiSpawnedKnown` and `m_convaiSpawned` (Bool). |
| `packaging/release-plan.json`, `scripts/development-files.json` | Ship and dev-install `spawned-characters.lua` |
| `bridge/spawned-characters.test.mjs` (new), `bridge/facial-graphs.test.mjs` | Tests below |

Installing needs a CET reload for the Lua and a game restart for the reds.

## Tests

- **`bridge/spawned-characters.test.mjs`:**
  - classify (ours, spawned, quest, unmanaged, prefix not substring)
  - `read` against a fake system: our tags are checked by name before any tag list, and only our tag names are ever passed in
  - the cache, retry when there is no answer, `reset`, and the bound
  - catalog `resolve` for a spawned Judy by record and by display name; the game-placed Judy is still refused; the story-bound fallback; never a child
  - policy (`spawned`, `protected`, our copy unchanged)
  - `beginFocus` passes `keepAI=true` only for spawned characters, and behaves as before without the module
  - wiring: identity, resets, packaging, nothing in `onUpdate`, Engagement
- **`bridge/facial-graphs.test.mjs`:** the existing contracts are updated for the spawned branches. A new contract covers generic recognition, the managed lookup first in extraction, never a holocall, the order of the gated-copy steps with one graph write, no roster or quest filter, the talk-time refusal and the Bool memo.
- **Results:** the full suite (`node scripts/run-tests.mjs`) passes, and `scripts/Compile-Redscript.ps1` compiles cleanly.

### Live check (owed, needs the game)

1. Spawn Judy and a ganger with a spawner. Talk to each (composer and mic). Each answers with her or his profile, Judy's voice, and lip sync. The probe log face status reads `prepared:…`.
2. Change the spawned Judy's outfit and talk again. The lips still move.
3. While the spawner has her following, talk mid-walk. She keeps following (no hold), and only her eyes and head turn.
4. Scan her. The name is unchanged. Tag her for a fight. She is not picked while friendly.
5. Invite our own Judy beside her. Both talk as Judy, and memory is shared.
6. FPS: the movement trace and perf probe show no new per-frame rows.

## Phase 2: group chat and reactions (built on branch `spawned-phase2`, from phase 1)

Written 2026-10-17. Unit-tested; not merged, not installed, not seen in the game.

**Finding them.** Nothing of ours lists another mod's characters, and a poll would cost frames. `service:nearby(player, radius)` in `mod/spawned-characters.lua` runs one targeting query (the same `TSF_NPC` query the auto-connect scan makes), keeps the NPCs that classify as spawned, and answers again from its cache for 3 seconds. It is asked only on an event:

| Event | Radius | What is done with the answer |
|---|---|---|
| Group key press (text or voice) | 8 m | Candidates for the round, after V's companions. Skipped once three companions already fill the round. |
| A fight starts (the observer's own half-second sample sees combat turn on) | 20 m | `watch`: remember up to three by entity ID. Skipped while both reaction settings are off. |
| A loot pickup (the loot observer's context capture, already event-driven) | 20 m | `watch`, as above. Skipped while Loot reactions is off. |

Without Codeware's dynamic entity system (`IsReady` false) none of this runs. The module never holds an entity beyond the 3-second scan cache: the watch list keeps entity IDs, and `Game.FindEntityByID` resolves them when the reaction list is built.

**Group chat.**
- A spawned character joins with any enabled profile. **Fixed 2026-10-17 (branch `group-count`):** the first build took roster characters only and found them by one scan; a player facing one of our companions, with two spawned characters nearby, got "Group chat needs two characters nearby" (facing a spawned one worked, because the faced character is always counted and our companion made two). Now the candidates are the scan's answer plus the spawned characters among the native candidates the same key press already gathered for the talk target (`convaiTalkNative`), so a character the scan misses still counts, and a generic one counts too. A generic person (a resident, an archetype or a generated passer-by name: `resident-*`, `npc-*`, anything in the archetype index) is flagged `generic` and carries its archetype facts, its district and its Night City name like a generic primary. Two generic people sharing a profile are two people: `choose` keeps both, and the round's audience (and the prewarm hint) lists the shared profile once, because the bridge reads it as a set. A roster profile is still one voice per round. The key press logs `Group candidates: companions=N spawned=M (found, generic, noProfile, unsupported, disabled)`, so a missing character can be told from a filtered one.
- **Fixed again 2026-10-17 (branch `group-fix2`):** the scan and the native talk-target candidates both report only what the camera sees, so a spawned character beside V but outside the aim cone (or behind V) was still dropped. See "Counting every spawned character" below.
- Order: the addressed character, then V's companions (nearest first), then spawned characters (nearest first). The round holds three.
- `choose` in `mod/group-chat.lua` skips a body already chosen (by entity) and a profile already chosen. The profile rule is not new: the bridge treats a round's audience as a set of profiles (`parseGroup` dedupes it, `bridge/group-prefetch.mjs` and `bridge/conversation-knowledge.mjs` refuse a repeat), and heard lines are matched to listeners by profile, so two bodies of one profile would answer as one character hearing herself. Because spawned candidates come after the companions, our own Judy is kept and a spawned Judy beside her is skipped, unless the spawned Judy was the addressed one. The earlier note said "by entity, not by profile key"; the entity half is built (rows, role, leave guard), the profile half stays for the reason above.
- The round's frozen rows carry `spawned`. Everything after that is the existing round: face request and keep-AI eye contact per speaker (phase 1), the live check each tick that the body still resolves to its frozen profile, and one reply at a time. Spawned members get no gesture role (the gesture controller works from party entries only).
- They never enter `companions`, `connectionProfiles` or the party hint file.

**Turn-context party.** For a round with a spawned member, the `party` callback adds that member (profile key and name, no activity) to "Also with V". The bridge then words it as company and claims nothing about what the character is doing (nothing of ours knows). A private turn and a round without spawned members are unchanged. The round-start hook (`groupChat.onSpawned`) drops the 5-second turn-context snapshot once so the new row is read; it fires only for such a round.

**Offers.** A spawned first speaker in a round makes no leave offer about our party (`leaveOffer` returns nil). Follow, drive and fight offers were already private-talk only and refused for a spawned character.

**Reaction witnesses.** Decision: a friendly spawned character with an enabled roster profile counts as a witness, and may speak the reaction, like one of V's companions.
- `reactionPeople` appends the watched characters after the companions: still here, within 20 m, not hostile to V (checked every sample, so one that turns on V drops out), and our own copy of a profile always keeps its place. Availability to speak is the same `canSpeak` test.
- `mod/battle-reactions.lua`, `mod/loot-reactions.lua` and `mod/loot-observer.lua` are unchanged: they already work from entity and profile rows. The bridge names a witness by profile in the battle context (`You were nearby during this encounter`) and the loot context.
- A spawned reaction speaker gets `ConvaiFaceRequest` (as in a talk) so its prepared face runs. No eye contact, no focus: reactions never turn anyone.
- A spawned enemy is still only an opponent name, as before.

**Cost.**
- No per-frame work. `onUpdate` is untouched. The half-second observer sample gains one boolean compare (`convaiSpawnedPeople.sample`) and, once per fight start, one cached scan.
- Per half-second poll with nobody remembered: one table length check. With up to three remembered: per character one `FindEntityByID`, one attitude read and one position read, plus `canSpeak`.
- A group key press adds one scan (reused for 3 seconds) when fewer than three companions are present. It happens before the round starts. A round's own steps (preview, look-ahead, the next speaker) are unchanged, so a round with no spawned characters has the same per-turn latency as before.
- The first scan in a crowd classifies each NPC it meets once (attached, alive, then the managed lookup, cached by entity hash up to 256): a few hundred native reads at most, once, on the key press or the fight start. Measure it with the perf probe (live check 7).

**Limits.** They get no movement, party, vehicles, seating, gestures, equipment or scanner rename. A spawned character is found only within 8 m (group) or 20 m (reactions) of V and only when the dynamic entity system manages it. The scan could miss one that is far from the player's frame (live check 3).

## Files changed (phase 2, branch `spawned-phase2`)

| File | Change |
|---|---|
| `mod/spawned-characters.lua` | `ready`, `scan`, `find`; service `available`, `nearby` (3-second cache), `watch`, `watching`; `reset` clears them |
| `mod/group-chat.lua` | `choose` skips a repeated body (entity) as well as a repeated profile; frozen rows keep `spawned`; `onSpawned` hook |
| `mod/init.lua` | Global `convaiSpawnedPeople` (`named`, `nearby`, `watch`, `sample`, `reactionRows`); `selectConversation` adds spawned candidates and marks a spawned primary; the `party` callback; `leaveOffer` guard; `reactionPeople`, `captureLootContext`, the observer sample and the reaction send (face request) |
| `bridge/group-chat.test.mjs`, `bridge/spawned-characters.test.mjs` | Tests below |

No redscript change: nothing to rebuild in the game's script cache. A CET reload installs it.

## Tests (phase 2)

- **`bridge/group-chat.test.mjs`:**
  - `choose` with spawned rows: order, one body one speaker, one profile one voice, the cap, only supported profiles, a round of two spawned characters
  - frozen `spawned` flag and the `onSpawned` hook (only for such rounds, a failing hook never breaks a round)
  - a full round through the adapter's `updateGroup` with a spawned first speaker: face request, eye contact, one audience, the companion hears the spawned line, and a speaker that stops resolving ends the round
- **`bridge/spawned-characters.test.mjs`:**
  - `nearby`: spawned only, nearest first, radius, the 3-second cache, a clock that goes backwards, no dynamic entity system, a failing scan
  - `watch`/`watching`: IDs only, three at most, gone ones dropped, expiry, nothing read while empty, `reset`
  - the adapter's `convaiSpawnedPeople`: roster profiles only, a scan per fight start (not per sample), nothing while the settings are off, hostile or distant characters dropped
  - `reactionPeople` merge with our companions, then the real battle and loot policies take the spawned witness (battle witnesses by profile, a loot offer to the spawned speaker)
  - the turn-context party row and its wording on the bridge side; the leave-offer guard; wiring and "not per frame" checks
- **Results:** see the TODO log entry of 2026-10-17 (`spawned-phase2`).

### Live checks owed for phase 2 (need the game and a spawner)

1. Spawn Judy (spawner) near V with one of our companions. Press the group key and speak or type. Both answer in turn; the spawned Judy has lips, eye contact and her own voice; our companion hears her line.
2. Spawn Judy and invite our own Judy beside her. Group chat: the addressed one speaks, the other is skipped, no error in the probe log. Repeat addressing the other.
3. Group chat with only spawned characters and no companions: two spawned characters give a round. Also face our companion with two spawned characters nearby, behind V as well as in front: three people, and the probe log line `Group candidates: companions=1 spawned=2`. Two spawned gangers on one generic profile plus a companion: three people, each speaking in turn.
4. Battle with a friendly spawned character near V and Battle reactions on: she can speak the opening or closing line, with her face; she is named in the battle context. One that is made hostile never speaks. Loot reactions: pick up an item next to her.
5. Confirm the `TSF_NPC` scan with `testedSet = Complete` finds a spawned character who stands behind V at 5 to 8 m (the auto-connect scan's own query; unconfirmed for characters outside the view).
6. The spawned character's first-speaker round offers no leave action even with a companion in the round.
7. FPS and latency: the perf probe and the stage clock show no new per-frame row, and a group round with no spawned characters keeps its usual first-reply time. The one extra row is the scan on the group key press and on a fight start.

## First talk without the connection wait (branch `spawned-preconnect`, from `main` 9415fdc4)

Live result (2026-10-17, the user): the first talk to a spawned character waited 3 to 5 s for Convai's connection, because nothing opened it until V spoke. Our own companions and the nearby slots did not have this.

**Cause.** Two gaps. On a player's own key `deferWarm` (`singleSession`) stops every background pre-open, free plan or paid. And the one thing that would have prepared a spawned character, auto-connect, gives two shared slots at 5 m, staggered 3 s, and skipped any profile that is also a party member.

**Design.** A lane of its own for spawned roster characters, in both halves:

- **Game side (`mod/auto-connect.lua`, `mod/init.lua` `scanNearbyCharacters`).** The scan that already runs once a second marks a row `spawned` when it is a roster character another mod or a spawner created (`convaiSpawnedPeople.named(key)` and the cached `convaiWorldPolicy.spawned(entity)`; residents and archetypes are not). Such a row is admitted on the first scan that sees it, without the stagger, in its own place: at most `maxSpawned` = 3, beside the two slots, with the same hold (40 s), age (10 min) and cooldown rules. A talked-to one leaves for the partner role. `publishFile` writes the list as `spawned` in `runtime/nearby-connections.json`, in the same heartbeat as before. No new per-frame work, no new native call, no new file. `mod/spawned-characters.lua` and `mod/group-chat.lua` are not touched.
- **Bridge (`bridge/nearby-warm.mjs`, `bridge/party-connections.mjs`).** `parseSpawned` reads the list (up to 3, stale after 8 s, invalid names refused). `PartyConnections.setSpawned` adds a `spawned` role to the plan: above the nearby ones, below the party, an invitation, the target and the partners, one entry per profile (a spawned Judy and our Judy share one connection; `alsoSpawned` marks it). The page opens through the same staggered, two-at-a-time `startWarm` as every party connection, never sends a message and never writes memory, and is closed when the game stops listing the character (unload what is unused). `NearbyWarm` also prepares the voice of a spawned character, after the partners.
- **Plan rules** (`spawnedWarmLimit`): the shared key allows 3; a player's own key allows `min(3, connectionLimit - 1)` (6 on a confirmed paid plan: 3; a plan of 2: 1; a free, unknown or unread plan: none, so the free plan behaves exactly as before); Mistral or the local AI text provider: none. One connection is always kept for the page V is on. A player's key still pre-opens nothing else in the background (party, nearby, prefetch, phone); only the spawned lane is exempt, and only while `spawnedWarmLimit` is above 0 (`warmDeferred`).
- **Interactions.** Opening a connection is not a turn (`docs/CONVAI_PAID_TIER.md`), so no interaction is spent.

**Numbers** (real bridge, simulated game and provider with delays shaped like the 2026-10-17 live round, a fresh connection 3.5 s; `node scripts/Measure-SpawnedConnect.mjs`, time from V's line to the first audio): own key on a paid plan, listed ahead 3.8 s against 7.4 s without the hint; shared key 3.9 s against 7.4 s; free plan 7.4 s, nothing opened; party Judy also spawned, with Panam: 2 pages opened, 4.0 s; three spawned on a paid plan: 3 pages opened, 4.0 s; three spawned on a plan of two: 1 page opened, 3.8 s. The remaining 3.8 s is the reply itself.

**Tests.** `bridge/party-connections.test.mjs` (role ranking, limit 3, dedupe, plan table, single-session with and without room), `bridge/nearby-warm.test.mjs` (`parseSpawned`, apply, voices, release), `bridge/auto-connect.test.mjs` (the lane, its cap and release rules, partner handoff, party overlap, source checks), `bridge/spawned-preconnect-bridge.test.mjs` (the real bridge: the first talk finds the page open on a paid plan and on the shared key; the free plan opens nothing; one page for a shared profile; three on a paid plan, one on a plan of two).

**Live check owed** (needs the Scripts install, a bridge restart and a spawner; "Auto-connect nearby characters" on):
1. Spawn Judy near V (within about 5 m) and wait 5 s without talking. `runtime/party-connection-state.json` lists `judy-alvarez` with role `spawned` and state `ready`; probe.log says `Auto-connect warming judy-alvarez (spawned)`.
2. Talk to her. The first reply starts without the connection wait: `runtime/bridge-latency.json` shows `connectionWarm` true for that turn.
3. Own key on a free plan: nothing opens ahead and the first talk takes as long as before. Own key on the paid plan: as in 1 and 2.
4. Spawn four: only three open. Walk away or despawn: their pages close after about 40 s.
5. Spawn Judy and invite our own Judy: one `judy-alvarez` connection, not two.
6. FPS: no new per-frame row in the perf probe; the scan row count is unchanged.

Not changed: a private talk to any other character on a player's key (a game NPC that is not spawned, a nearby one) still opens its connection when V talks; that is the `deferWarm` decision about interactions and memory-user slots.

## Counting every spawned character, and keeping their connection (branch `group-fix2`, from `main` cf97b9aa)

Written 2026-10-17. Unit-tested; NOT merged, NOT installed, not seen in the game. Two live bugs from one test (`probe.log`, session from 09:08Z): V had our companion Alex plus a spawned Jackie (about 5 m) and a spawned Judy (about 1.7 m).

**Bug 1: only two answered the group key.** Every key press logged `Group candidates: companions=1 spawned=1 (found=1 ...)`, so one spawned character was never a candidate. Cause: every query we have, the targeting search the group key used (`GetTargetParts`, tested set `Complete`) and the native talk-target candidates of the same key press, reports only what the camera sees. The companion-marking notes say the same ("it evidently does not return every NPC in range"), and the tactic candidate list of the same session never listed the spawned Judy either. A spawned character behind V or outside the aim cone is invisible to all of them while V faces Alex. The earlier fix (`group-count`) added the native candidates, which only helps for a character inside the cone.

**Fix.** Spawned characters are remembered by entity ID (never a handle, at most 12, the one seen longest ago leaves first; `service:remember` in `mod/spawned-characters.lua`), and resolved directly at the key press with `Game.FindEntityByID` (`service:recall`), so a remembered character counts wherever V faces. What feeds the memory, none of it new per-frame work:

| Source | When | Cost |
|---|---|---|
| The once-a-second auto-connect scan (`scanNearbyCharacters`, any spawned character it reports, roster or generic) | every scan, while "Auto-connect nearby characters" is on | the entity ID of a character the scan already classified (the classification is cached by `profileIdentity`) |
| Every group key press (`convaiSpawnedPeople.nearby`): what its scan and its native candidates found, with the profile key | key press | nothing extra |
| Every talk key press, private or group (`convaiSpawnedPeople.noteNative`): the spawned characters among the native candidates | key press | cached classification, a handful of candidates |
| A spawned character V talks to (`selectConversation`) | key press | one table write |

The range is the one group chat uses for V's own companions: 8 m (`companions.conversationCandidates(player, 8)`, now `convaiSpawnedRange`). At the key press `service:nearby(player, 8, native)` returns the characters from three sources, in this order of trust: `scan` (one targeting query, reused 3 s), `native` (the key press's own candidates) and `remembered`. A remembered ID is dropped, with the reason, when it no longer resolves (`gone`, forgotten for good), is dead (forgotten), no longer reads as spawned (forgotten), is not attached right now (`detached`, kept: it may stream back in) or is beyond 8 m (`out-of-range`, kept: it may come back).

**The log line** now says how each character was found and why any was left out, with distances:

```
Group candidates: companions=1 spawned=2 (found=2 generic=0 noProfile=0 unsupported=0 disabled=0) radius=8m; counted: judy-alvarez d=1.7 via remembered, panam-palmer d=5.0 via scan; left out: none
```

`via` is `scan`, `native` or `remembered`. A left-out entry reads `<profile> d=<metres> <reason>` with the reason `out-of-range`, `gone`, `dead`, `not-spawned`, `detached`, `noProfile`, `unsupported` or `disabled` (at most six of each, then "+N more").

**Limit.** A spawned character that no query has ever reported (spawned behind V and never in view since, with the auto-connect setting off and no key press that saw it) cannot be found: no list of ours holds another mod's characters, and the engine has no query that does not depend on the camera. The first key press or scan that sees it fixes this. With the default settings the scan sees it as soon as it is in view of V within 5 m, and V has to look at a character to talk to it anyway. The log line shows `spawned=0 ... counted: none` for this case, and `left out` for every other.

**Bug 2: her connection went away.** `probe.log`: Judy was warmed as `spawned` at 09:10:38, became the partner when V talked to her (`Auto-connect partner judy-alvarez`, 09:10:42), then `Auto-connect partner released judy-alvarez (no exchange)` at 09:13:54 while she still stood beside V. The bridge closed her connection; at 09:14:14 she was warmed again by gaze and the F6 at 09:14:36 showed "Preparing connection". Causes, confirmed in the code:

1. **The partner role never returned to the spawned lane.** The role replaces a lane place (`updatePartners` removes the lane entry), and the release put her under the 20 s cooldown. Re-admission needed the scan to report her again, which it does not while she is outside the camera's view (the same limit as Bug 1). It re-warmed only when V looked at her.
2. **The lane lost her after 40 s without a sighting as well.** Jackie was released `(idle)` at 09:08:50 and Judy at 09:09:06, about 40 s after V turned to Alex, with both still in the world: the lane holds a character only while the scan reports it.
3. **The 10-minute age limit** would have closed a spawned character's connection while it still stood beside V, then blocked it for 3 minutes.
4. **The bridge dropped the page across a role change.** `NearbyWarm.apply` set the three lists one after another (`setPartners`, `setSpawned`, `setNearby`), each followed by a plan reconcile. A profile that moved from one list to another was in no list after the first call, so `host.retain` closed its page, and the next call opened it again.

**"No exchange" is correct as designed.** The partner role ends 180 s (`partnerIdle`) after the last turn with that character. Judy's last turn was the round at 09:10:47 to 09:10:54 (she was the addressed character), and the release came 180 s later. What was missing is that a group round only counted for the character V addressed (`context.talking` is the primary's profile): a partner who answered as another speaker had talked and did not count. That is now counted.

**Fix.**
- `mod/auto-connect.lua`: a partner that is a spawned roster character (it came from the lane, or the adapter's `spawned(partner)` says so, which also reads the remembered IDs) goes **straight back to the spawned lane** when the partner role ends for `no exchange`, `another partner` or `replaced`, as long as it is within 8 m of V (`locate`) and the lane has a place (cap 3). It is listed under `spawned` in the same write that stops listing it under `partners`, with no cooldown and no release log (`Auto-connect partner judy-alvarez back to the spawned lane (no exchange)`). Parting ways, a scene, a party join and a full lane release as before. A spawned character in the lane has no age limit while it is wanted. Every character of the running group round counts as an exchange for an existing partner (`roundKeys`, read only while a partner exists).
- `mod/init.lua`: the scan adds the remembered spawned roster characters within 8 m that it did not report (one `FindEntityByID` each, in the once-a-second scan only), so the lane keeps wanting a character that stands near V wherever V looks. It passes `spawned` and `roundKeys` to auto-connect.
- `bridge/party-connections.mjs` `setAmbient` and `bridge/nearby-warm.mjs`: the partner, spawned and nearby lists are applied as **one** plan change, so a profile that changes role keeps its open page (the entry keeps its identity; only its role changes). A connections object without `setAmbient` still gets the three setters in turn. The plan rules are unchanged: the shared key allows 3 spawned, a player's own paid key `min(3, limit - 1)`, a free own key none (so on a free own key the partner's connection ends with the partner role, as before).

**Cost.** No per-frame work. The scan gains one table insert per spawned character it reports and, while any spawned character is remembered, one `FindEntityByID` plus an attachment and a position read per remembered roster character (at most 12, typically 1 to 3), once a second. The key press gains the same for up to 12 and one cached classification per native candidate.

**Files.** `mod/spawned-characters.lua` (`remember`, `recall`, sources and `report` in `nearby`), `mod/init.lua` (`convaiSpawnedRange`, `convaiRoundKeys`, `nearby`, `describe`, `noteNative`, the scan, the auto-connect options), `mod/auto-connect.lua`, `bridge/party-connections.mjs`, `bridge/nearby-warm.mjs`. Tests: `bridge/spawned-characters.test.mjs`, `bridge/auto-connect.test.mjs`, `bridge/party-connections.test.mjs`, `bridge/nearby-warm.test.mjs`. Needs a CET reload for the Lua and a bridge restart for the bridge files; no redscript.

**Live check owed** (the Lua install and a bridge restart, "Auto-connect nearby characters" on, a spawner):
1. Spawn Jackie (about 5 m) and Judy (about 1.7 m) with our companion Alex beside V. Look at each for a second, then face Alex and press the group key (F7), text or voice. Three people answer. `probe.log` reads `Group candidates: companions=1 spawned=2 ... counted: judy-alvarez d=1.x via remembered, jackie-welles d=5.x via scan` (or `native`).
2. Face a spawned character and press F7: three people, the faced one first.
3. Walk one spawned character beyond 8 m and press F7 facing Alex: two people, and the line says `left out: <profile> d=<metres> out-of-range`. Despawn one: `gone`.
4. Turn so Judy is behind V (not on screen) and press F7 again: still three.
5. Talk to Judy (F6), then leave her standing beside V for four minutes without talking to her. `probe.log` shows `Auto-connect partner judy-alvarez back to the spawned lane (no exchange)`, never `partner released judy-alvarez`. `runtime/party-connection-state.json` shows her role change from `partner` to `spawned` with state `ready` the whole time, and F6 after that has no "Preparing connection" notice.
6. Face away from Jackie and Judy for two minutes: neither shows `Auto-connect released ... (idle)`. Walk them beyond 8 m: released about 40 s later.
7. Group round addressed to Alex with Judy as the second speaker, then wait: her partner role is not released 180 s after V's last line to her but 180 s after the round.
8. FPS and latency: no new per-frame row in the perf probe, the group key press time unchanged.

## Night City Allies followers: connected from spawn, and kept while they stand near V (branch `fix/nca-connect`, from `main` 54545022)

**Live result 2026-10-18 (probe.log 20:22 to 20:29Z).** Lucy, Rita and NCA's Judy did not connect when spawned and disconnected within a minute while V stood beside them: Rita was warmed by `(gaze)`, not `(spawned)`, and later `(replaced)` out of a slot; Rita and Judy were `partner released ... (scene)` twice; Lucy was `released (idle)` 143 s after she went back to the lane; each came back only after the 20 s cooldown.

**Causes and fixes** (Lua only; no bridge change):
1. **A hub is not a scene.** Facing an NCA follower shows NCA's own interaction menu, a dialogue choice hub. The game raises V's scene tier to 2 (staged gameplay) while one is up (the same signal `mod/world-talk.lua` already tells apart: "a prompt alone never refuses"). `scene = tier ~= 1 or dialogue` read that as a scene, so `updatePartners` released the partner role (`releasePartner`, 20 s cooldown) and `blocked` (which also counts `choices`) stopped the once-a-second scan and every admission. Now `init.lua` also passes `sceneReal` (tier 3 or above). For a spawned partner, `scene` alone changes nothing; `sceneReal` sends it back to the lane (`backToLane`, reason `scene`), never to a release; with no lane place or beyond 8 m it stays a partner and leaves by the usual rules. An ordinary world partner and a story character behave as before (a scene still releases them).
2. **A blocked world dropped the lane.** While `blocked` (a hub, a vehicle, combat, tier 2) the scan is not asked, so nothing reported a follower beside V and `lastWanted` aged 40 s to an `(idle)` release. Now a lane entry keeps `lastWanted` fresh while the world is blocked; the next unblocked scan decides again. A spawned release has no cooldown (it was unreported, not unwanted), so a follower reported again is warmed on the next scan.
3. **Rita was never in the lane.** Two ways in. (a) The gaze path called `want(key, name, 1, 0, entity)` without the spawned flag: the scan that carries it runs once a second, so a gaze whose dwell ended on any other tick (nine in ten) put a spawned character in a slot (and a slot can be replaced by the next gaze). `updateGaze` now passes the cached classification (`convaiSpawnedCharacters:is`, no new native read) to `autoConnect.look(..., spawned)`, and a slot entry the scan later reports as spawned moves to the lane in place (`moved to the spawned lane`). (b) A body made from NCA's clone of a game-placed record (`NCA.Character.lizzies_bouncer`, a record the game also places) may not read as managed or may carry the record's quest flag. `characterCatalog.isCloneRecord` and a `clone` option of the spawned-character service (`init.lua` passes it: the record's hash from the catalog's `NCA.` rows, or its debug name when the engine gives one, asked once per entity with the cached read) make such a body spawned whatever those two answer. The `NCA_Companion` tag is not read: it would match another mod's tag, and a clone made by any record-cloning mod is covered by the prefix data.
4. **Why a remembered follower is not counted** is now logged once per change in the scan (`Spawned character not counted: <profile> <reason> d=<m>`: gone, detached, out-of-range, dead, not-spawned), so a body that NCA made again under a new entity ID, or one that drifted past 8 m, is visible next time. A roster character the scan counts as the game's own gets one line per entity (`Roster character counted as game-placed: <profile> entity=... record=... managed=...`), so if Rita still is not spawned the record and the managed answer are in the log.

**Judy's first reply without voice (generation 5)** was not the connection. The user changed the provider to Mistral and Mature content to off just before it; the reply came from Mistral and its cloud voice (Voxtral) answered HTTP 403 `Request blocked by guardrail policy` (`type: guardrail_violation`) on the request, so by design the reply was shown as written text (`speech=idle face=none`; a cloud voice that fails before audio never gives the reply to another voice, `bridge/voice-selection.mjs` `synthesizeHead`). The bridge prints it as "did not accept the API key" and pauses Voxtral for 20 s (`forbiddenCooldownMs`), which is a mislabel for a policy block; left as it is (a bridge change, not part of this fix).

**Cost.** None per frame: the gaze classification is one cached lookup at the existing 5 Hz look sample, the scene fields are two comparisons in the 0.1 s poll, the lane refresh is a boolean in the existing loop, the drop log runs inside the once-a-second scan.

**Live re-check** (Scripts install of the four changed `mod/` files, CET reload; "Auto-connect nearby characters" on):
1. Recruit Lucy, Rita and NCA's Judy with NCA, stand with them, do not look at them. Within a few seconds `probe.log` shows `Auto-connect warming <key> (spawned)` for each, never `(gaze)` or `(near)` for Rita.
2. Face each in turn, with NCA's menu showing, for a minute; talk to two of them. No `partner released ... (scene)`, no `released ... (idle)`; `runtime/party-connection-state.json` keeps their connections `ready`.
3. Ride in V's car with them for a minute, then get out: the same, no `released`.
4. Walk one beyond 8 m: a `Spawned character not counted: <key> out-of-range` line, and `released (idle)` about 40 s later.

## "Preparing connection" on Mistral and the local AI (branch `fix/nca-connect-bridge`, from `main` 9273275d)

**Live result 2026-10-18 (21:02Z, after the lane fix).** The three followers were warmed `(spawned)` and nothing was released, yet the first text to Rita or Judy showed "Preparing connection to <name>...", and `runtime/party-connection-state.json` listed no connection for them (`spawned` lists them, `connections` does not).

**Cause.** Not the plan limit. That session's conversation provider was Mistral (`settings.json` `conversationProvider: "mistral"`, last written 20:25Z; `runtime/mistral-state.json` `effective: "mistral"`; the bridge log's last transition is `Conversation provider: mistral`; the voice was Voxtral). With a text provider no Convai connection exists: `spawnedWarmLimit` is 0 (`textProvider`) and `deferWarm` holds the nearby ones as `waiting`, by design. The Lua notice only read `party-connection-state.json` for a `ready` private entry, so it showed for every character that has no entry, here every one but the party member (whose entry is a no-op). `bridge/party-connections.test.mjs` now pins the other case, the shared key on Convai: party, a partner and spawned characters are all in the eleven-connection plan and open before the first talk, and `spawnedWarmLimit` is 3 there.

**Fix (Lua only).** `mod/auto-connect.lua` takes `options.noConnection()`; while it is true `talkNotice` shows nothing and `ready` is true (a holocall does not ring for ever). `mod/init.lua` passes the bridge's applied provider (`manager.mistral().effective` is `mistral` or `local`, read from `runtime/mistral-state.json` at most every 1.5 s, and only on a talk start or a holocall poll). Convai (shared key or the player's own) is unchanged: the notice still shows while the connection is really being prepared, and a player's own free-plan key still opens none ahead, since it holds one connection.

## Ready for builders (Sonnet, from this document)

1. **Optional invite notice** (above), only if players ask.
2. **Live checks** above (phase 1 and phase 2), through the existing probes and the face status in the probe log. They need the user's game session.
