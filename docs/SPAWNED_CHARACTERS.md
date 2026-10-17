# Characters spawned by another mod

Written 2026-10-17 on branch `spawned-characters`. Phase 1 is built and unit-tested here. It has not been merged or installed, and nobody has seen it in the game.

Players often use a spawner, another mod or tool, to put characters into the world: Judy, Panam, a ganger, a custom NPC. That mod owns the character's body. It decides where the character goes, how they follow, what they wear and what they do in a car. This document sets out what our mod does with such a character. The short version: they can talk with their own profile, voice and memory, and their face moves with the voice. Nothing of ours moves them.

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
| Group chat, turn-context party, battle and loot witnesses | Not yet (phase 2) | see "Ready for builders" |

## Invite and party

- **Manager or phone invite of the same character.** Our invite spawns our own managed copy, as always. A spawned Judy and our Judy can stand side by side. Both talk as Judy, with one voice and one memory. Only one conversation runs at a time. A player who wants Judy to follow with our systems invites ours. A player who wants the spawner's Judy keeps hers, and she still talks.
- **Adoption is never allowed.** Taking the spawner's character into our party would make two mods command one body. The world-NPC adoption path stays disabled, and `convaiWorldPolicy.spawned` is the predicate to refuse it if it ever returns.
- **Optional notice (phase 2).** When the player invites a profile they talked to through a spawned character in this session, say once that another copy is already here. We cannot list another mod's entities without its tag, so only the talk cache can know this. Low value: build it only if players ask.
- **Dismiss and delete** act only on our own entries. A spawned character is never in `companions` state.

## Edge cases

- **Save and load.** The reference spawner spawns with persistence off, so its characters are gone after a load, and "respawn all" creates new entity IDs. Our Lua cache is cleared on session release, and new IDs are read afresh. Memory is keyed by profile, so a respawned Judy remembers the previous talk.
- **Despawn mid-conversation.** This goes through the existing talk path. The focus holds a weak reference and ends on `IsAttached` or `IsDead` checks. `ConvaiFaceReady` fails on a detached puppet, so no face write lands. Nothing of ours holds the entity alive.
- **Duplicates.** A spawned copy and our copy of one character share a profile, as above. Phase 2 group chat must dedupe speakers by entity, not by profile key.
- **Appearance changes.** The spawner changes outfits by rebuilding the appearance, which replaces `face_rig` with the vanilla graph. `OnCompanionExtract` now catches spawned builds, and `PrepareExtractedComponents` prepares the new face and updates the stored graph path, so `ConvaiFaceReady` keeps passing.
  - A rebuild during a conversation briefly fails the ready check until the extraction finishes, then the face resumes.
  - The rebuild is not ours, so there is no flash risk from us.
- **Car.** The spawner can seat its followers in V's car and drive. We send no hold, so talking to a seated spawned character does not fight its mount. Eye contact uses eyes and head only.
- **Combat.**
  - The spawner's followers fight on V's side by their own attitude group.
  - Our tactic never picks them except as a tagged hostile in combat, for example after the spawner set them hostile.
  - Battle reactions may already name them as nearby people through the game's own perception. Witness inclusion is a phase 2 decision.
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

## Ready for builders (Sonnet, from this document)

1. **Phase 2, group chat and turn context.** Include spawned characters as speakers when the player addresses a group, deduped by entity. They stay out of `companions` state. Files: `mod/group-chat.lua`, the turn-context party in `mod/init.lua`.
2. **Phase 2, reaction witnesses.** Decide whether battle and loot reactions may mention a spawned character by profile. Default: as an ordinary NPC.
3. **Optional invite notice** (above), only if players ask.
4. **Live check** above, through the existing probes and the face status in the probe log. It needs the user's game session.
