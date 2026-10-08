# World companions: "follow me" and "you can go"

A character V meets in the world (Judy at her place, a resident, an archetype NPC) can join the party when V asks them to come along. Any party member, summoned or adopted, can leave when V sends them away. Both are Convai actions. The model decides from the conversation whether V meant it. The mod never matches V's words.

## Mechanism: a managed stand-in, not the live NPC

The world character is not adopted. A managed copy takes its place:

1. The copy is created through the normal party queue: same TweakDB record, the original's current appearance and orientation, placed at the original's spot when that spot passes the usual placement checks. A pedestrian's record is crowd-flagged, and `ScriptedPuppet.IsCrowd()` reads the record, so a copy spawned from it is a crowd member and cannot follow. Such a copy is spawned instead from a private clone of the record with `isCrowd` and `isLightCrowd` off (`CyberpunkConvai.NonCrowd_<record>`, `mod/companion-records.lua`, the same mechanism as the Johnny combat clone). The clone has the same template, appearances and conversation profile, so the copy keeps the original's look and voice.
2. The frame the copy is attached, the original is hidden with the same runtime visibility event the phantom controller uses (`enteventsSetVisibility`, source `PhantomEntitySystem`).
3. When the copy leaves the party, the original is shown again once V is more than 60 m away, is looking more than 70° away from it, or after 20 s. It then carries on with its own routine.

Why not give the live NPC `AIFollowerRole`:

- **Streaming.** Community and crowd NPCs belong to their spawner and are streamed out when V leaves the area, so a live follower would vanish within a few hundred metres. A `DynamicEntitySystem` copy is `alwaysSpawned`.
- **Ownership.** Every native mutation in the companion code (dismiss, delete, fast-travel recovery, chauffeur, reload cleanup) first proves ownership with `IsManaged` and the `CyberpunkConvaiCompanion` tag. A live NPC cannot pass those checks, so it would need a second, unproven code path.
- **Quest state.** Changing a quest or community actor's AI role can break the scripts that own it. The copy has no quest identity. The original is left alone apart from visibility, which is runtime-only and is reset by any load.
- **Persistence and duplicates.** Copies are created with `persistState`/`persistSpawn` false, so after a load there is no party and the original is visible again. Nothing is saved.

The copy goes through the same invitation path as a Characters-page summon. The party has no size limit (see Party size in `docs/MANAGER_UI.md`). It uses the same duplicate rules, Current party row, Dismiss, fast travel, vehicles and tactics.

## Safety checks (`mod/companion-adoption.lua`)

Follow is offered only when every check reads cleanly. A signal that cannot be read counts as a refusal. The refusal reason goes to the model, which declines in character. Each check maps to one reason code:

| Check | Reason |
| --- | --- |
| `IsQuest()` or not `IsOnAutonomousAI()` (a quest or scene drives its AI) | `quest` |
| Scene system `IsEntityInScene` / `IsEntityInDialogue` | `scene` |
| NPC or V in combat | `combat` |
| `IsPrevention()` / `IsCharacterPolice()` (all police, not only mid-incident) | `police` |
| `IsVendor()` (shops would lose their trader) | `working` |
| `IsHostile()` | `hostile` |
| Mounted in a vehicle | `vehicle` |
| Already a vanilla companion, has any AI role, no AI, a child | `busy` |
| The record cannot be copied (the non-crowd clone failed), or a copy of it already failed this session | `unavailable` |
| A named character already in the party or already being adopted | `already-here` |

Generic people (residents, archetypes) may follow more than once, because each body is a different person. A named character cannot. The same checks run again when the action arrives and once more just before the copy is placed. If the original has walked more than 15 m away, or a quest has picked it up in the meantime, the reservation is released with a notice and nothing is hidden.

Generic people have no per-character memory to prepare, and an ambient profile has no connection without a body. They therefore join as a model, and their conversation profile is assigned when the copy is attached. Their short-term chat session restarts with the copy's new entity. Named characters keep their profile session.

## Actions (`bridge/companion-actions.mjs`)

The mechanism is the same one used for driving and tactics. It sends a silent `context-update` with `action_config`, takes a one-use token bound to the request, the 90 s offer and 5 s delivery TTLs, and checks the source participant. The game validates the exact packet against its lease (`mod/gameplay-actions.lua`).

- **`Follow V <token>`**: offered in private chat with a non-party world character that passed the checks. A refused follow arms no action. It only adds an instruction to decline in character, so a quest NPC never says "sure" and then stands still.
- **`Leave V's Party <token>`**: offered in private chat with a party member, summoned or adopted. A driver mid-trip is not offered.
- **Group chat**: only the first speaker of a manual group round gets an offer, and it is a leave offer only. The offer has one action per party member in the round (`<Name> Leaves V's Party <token>`, or the plain name for the speaker), plus `Everyone Leaves V's Party <token>` when there are several members. Only the companion V addresses leaves, unless V clearly sends everyone away. Look-ahead speakers never admit actions.

The prompt text tells the model what counts as a clear request ("come with me", "follow me", "let's go"; "you can go", "go home", "get lost", "we're done here"). It also lists casual phrases that must not trigger anything: "leave it", "leave me alone for a sec", "let's leave this place", "let's get out of here", and talk about someone else leaving. These are guidance for the model, not patterns the code matches.

## Timing

- **Follow**: the party place is reserved and preparation starts when the action arrives. The copy is placed only after the reply that accepted has finished playing, or after 30 s at most.
- **Leave**: the companion waits until its goodbye has been heard. In group chat it waits until the whole round has ended, or 30 s at most. It then walks away:
  - **Direction**: toward its original's home when that spot is between 8 and 60 m away, otherwise away from V. The goal is never a blind point: while no goal is held (a few candidates per update, so no frame pays for the whole search) each candidate must have walkable ground within 3 m on her floor, end at least 12 m from V, and have a native route that is no detour (at most 4 m longer than the straight line), stays on one floor and fits the actuator's clearance proof (about 2 m per box, at most 64). Order: home, then 24, 17 and 29 m, each fanned out at 0°, ±40°, ±80° and ±120° from straight away (never back toward V). A goal the movement actuator still refuses, or that gets her 1.5 m nowhere within 4 s, is dropped for the next candidate; the list is tried twice.
  - **Removal**: through the Current party Dismiss path, once it is out of V's view (more than 70° from where V is looking) and either 25 m away, or at least 8 m away and out of view for 3 s.
  - **Safety limits**: a companion who makes no headway (1.5 m) for 6 s is removed as soon as she has been out of V's view for 1 s, and anyway after 15 s without headway, in view or not. Otherwise she is removed after 30 s, or after 3 s if it never starts walking (seated in a car, in transit). She never stands there for good.
  - **While it walks**: catch-up teleports and tactics do not apply, and it can't be sent away twice.
  - **From the menu**: Dismiss in Current party stays instant. Either way the adoption ends and the original returns.

## Ending cases

- **Fast travel**: the copy travels with the party as usual. The hidden original stays in its area and is streamed out. When it streams back in later it is a new, visible entity.
- **Vehicles**: the copy rides like any companion. Asking a mounted NPC to follow is refused (`vehicle`).
- **Parting far from home**: the copy is removed where it stands. The original is wherever its spawner keeps it, shown again if it is still loaded, or respawned normally later.
- **Crowd originals**: the game pools crowd people, so a hidden crowd original is shown again as soon as V is 50 m away, even while its copy stays in the party.
- **Death or failure of the copy**: the adoption ends and the original is shown again out of view.
- **Load, death, quit**: references are dropped without native calls. Copies are nonpersistent and visibility is runtime state.

## Conversation partner

When an adopted character joins, `convaiAutoConnect.promote(key)` (`mod/auto-connect.lua`) removes it from the partner role. From then on the party list owns its private connection (`bridge/party-connections.mjs` ranks `party` above `partner`), so no connection is opened twice. A hidden original is excluded from the talk key, from auto-connect scanning and from tactic target marking.

## Known limits

- The walk-away heads home or away from V. It does not look for doors or roads. A companion with no reachable goal stands still and is removed once V cannot see her, or after 15 s.
- First in-game result (2026-10-08): the leave reached Lua and was accepted, but all six blind 35 m goals of the old search (straight away, then 50°, 100°, 160° turns) were refused within three seconds ("navigation" and "destination" rejections), so Judy stood until V had walked far enough for the out-of-view removal. Fixed by the reachable-goal search above.
- A copy rejected for its record ("unexpectedly joined the crowd", no AI controller, an authored AI role) marks that record as not copyable for the session, so the next character with that record is never offered Follow. Its failure notice is a menu-style notice, not a spoken line.
- When the original's spot is blocked by its own body, the copy is placed at the nearest clear spot (up to about 1 m away), or near V when the original stood more than 6 m from V.
- A hidden original still has collision and its own AI while it is hidden.
- "Wait here" is not a pause: the companions have no wait-in-place behaviour, so the model treats it as leaving only when V clearly means they part ways.

## What to check in game

Install: CET reload for `mod/companion-adoption.lua` (new), `init.lua`, `companions.lua`, `manager-party.lua`, `gameplay-actions.lua` and the 15 locales. Bridge restart for `bridge/companion-actions.mjs`, `protocol.mjs`, `convai-bridge.mjs` and the rebuilt `runtime/realtime-client.js` (`npm run build:voice`). `probe.log` lines start with `Adoption` and `Departure`.

1. **Judy in the world** (not summoned; free roam, no active job): say "come with me". She answers, and only after the line does a copy appear in her place while the original vanishes. Check: no visible pop or double, same outfit, same facing, and the copy is listed in Current party with Dismiss.
2. **Hiding**: the original really disappears (the `PhantomEntitySystem` visibility source on a non-phantom NPC is the main unknown). Also check that no invisible body blocks V, and that the talk key and the tactic marker never pick it.
3. **Refusals**: during a quest step (a quest NPC, a scene, a dialogue choice running), an NCPD officer, a vendor, a ganger hostile to V, someone in a car, and during combat. Each declines in character and nothing spawns. Also note whether ordinary NPCs read as "busy" because of an AI role (log the reason).
4. **Crowd pedestrian, resident or archetype**: one follows, spawned from the non-crowd clone (`probe.log` shows no "joined the crowd"). Check:
   - **Look**: the same outfit and face as the original.
   - **Talk**: the copy answers in the same voice, as the same kind of person, in a new session.
   - **Movement**: it follows like any companion, without fleeing or wandering off in a crowd routine.
   - **Combat**: watch how it reacts. A civilian reaction preset may make it cower.
   - **If it still fails**: the failure is safe. The original is never hidden, the place is freed, and that record is not offered Follow again.
5. **Leave, private**: "you can go" or "go home" to an adopted Judy, and to a Characters-page summon. Check:
   - **The walk**: she says goodbye, then walks off (toward home, or away from V) and disappears only when V isn't looking and she is 25 m away. Turning away for 3 s at 8 m or more also works. She never vanishes in plain view before 30 s.
   - **The original**: the original Judy reappears at home out of view.
   - **Menu Dismiss**: Dismiss in Current party is still instant.
6. **Casual phrases**: "leave it", "leave me alone for a sec", "let's leave this place" while companions are present. Nobody leaves.
7. **Group chat** with two companions: "Panam, you can go home". Only Panam leaves, after the round. "Both of you, go home" makes both leave.
8. **Partner role**: after a follow, `probe.log` shows 'partner ... joined the party', and the party connection is ready without a second warm-up.
9. **Ending cases**: fast travel with an adopted member (it returns with the party, wearing the same appearance), riding in a car, parting 500 m from the original's home, saving and loading (no party, original visible).
10. **Large party**: with 8 or more members, "come with me" is still accepted (there is no `party-full` reason). The copy takes the next formation place behind the group and the Current party list grows.
11. **Crowd pedestrian**: once V is 50 m away the original pedestrian is visible again, while the copy keeps following.
