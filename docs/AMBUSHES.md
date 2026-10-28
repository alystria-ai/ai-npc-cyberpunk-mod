# Revenge ambushes

Written 2026-10-28 on branch `feat/gameplay-ambush`. Settings > Gameplay > **Revenge ambushes**, **off by default**. Offline-tested only (see "Not yet seen live").

A gang that V keeps killing may, rarely, send a small squad after V. The squad starts out of sight, runs at V, and one member shouts a short threat in its own
words (an AI line through the mod's voice route). Nothing else about the game changes.

The owner's ask (28 October): "I think the game has this kind of system already, check online so we could perhaps borrow it and only add the AI talk to it and
select when it happens."

## What the game has, and what was borrowed

Searched online on 2026-10-28 (Nexus pages answered 403 to a fetch, so only search summaries and GitHub were readable). Not checked in the game itself.

| The game's | What it is | Usable here? |
|---|---|---|
| Gang retaliation car chases (added in patch 2.1) | A gang's cars chase V. Built from `DynamicVehicleData` records of the DynamicSpawnSystem (`gang_chase_<gang>_small_01..03`, `mini_world_story_gang_chase_<gang>_vehicle_01..02` in `r6/tweaks/base/gameplay/static_data/database/dynamic_spawn_system/`), whose units are `Character.gang_retaliation_enemies_<gang>_<role>` records. Players report it starting after hostile acts against a gang inside a quest or gig (a Maelstrom chase after the Flathead job is the usual case), and ending when the gang is dealt with or outrun. | The trigger is not usable. It is scripted into quests and world stories, and no function, setting or tweak that starts one on demand was found. The mod "Remove Gang Retaliation" can only switch chases off by emptying the `vehicleRecord` of those records. What is usable is the **fighters**: the retaliation characters are real, tuned fighters. They are the squad's first choice when nothing V killed is known. |
| Reinforcements (backup calls in a fight) | A gang member in a fight calls backup. Community add-ons ("Reinforcements System Delayed" and others) change its chance and delay. | No. It only exists inside a fight that has already started, so it cannot start one. |
| The prevention system | The police: heat, patrols, the chase. | No. Police only. Read for one thing: a wanted level keeps an ambush away. |
| Community mods that do the same job (for example the CET and redscript mod "Gang Retaliation" on GitHub: DynamicEntitySystem spawn with a tag, a reachable spot, taunts) | A mod-made squad. | They confirm the way: the smallest spawn that works from a mod is a `DynamicEntitySystem` entity, which is also what this mod uses everywhere. |

So there is **no usable base system to trigger**. The mod follows the owner's fallback: the smallest spawn it already uses, and it borrows the game's own fighters.

What the squad is made of, in order (each record is checked against the game's TweakDB before use, so a name this game build lacks is skipped):

1. The fighters V actually killed (their `Character.*` record is remembered per gang, up to six). Bosses, netrunners, snipers, heavies, machines, drones, vendors,
   dogs, crowd and quest actors are never copied (`NOT_A_GRUNT`).
2. The game's own `gang_retaliation_enemies_*` fighters of that gang (`SEEDS`, Maelstrom, Tyger Claws, Valentinos, 6th Street, Animals, Wraiths).
3. An ordinary grunt record of the gang (Maelstrom, Tyger Claws, Valentinos, Aldecaldos).
4. None found: that gang sends nobody this session (logged once as `no fighter record found`).

## When it happens

Event-driven plus a slow check, never per frame.

| Rule | Value (`mod/revenge-ambush.lua`) |
|---|---|
| Grudge | Fed by the Street reputation recorder's deeds, one table update per kill V makes. A kill others saw is 1 point, an unseen kill 0.25, a takedown that spares the target 0.4 (0.1 unseen). Police and crowd deaths never count. Halves every 14 game days, capped at 30. |
| Threshold | 6 points for one gang. |
| Look | Every 30 s of play while the setting is on and nothing is happening. Chance 25% at the threshold, plus 2% per point above, at most 60%. |
| Squad size | 2, 3 above 10 points, 4 above 16. |
| Cooldown | 45 minutes of play between two squads, whichever gang. 10 minutes after a squad could not be placed. About half the gang's grudge is spent when a squad is sent. |
| After a load | 4 minutes of play first. V must also have been out of a fight for 90 s. |
| Never | In a fight, a scene or quest dialogue, a phone call, a vehicle, an interior, a safe zone (NoCombat), while the police are after V (heat above 0), or when the world cannot be read. |
| Length | A squad lasts at most 4 minutes. Left more than 170 m behind it goes out of sight. A fallen member stays 2 minutes, then is removed. |

The grudge is saved in `runtime/ambush-state.json` (written on a squad, every 5 minutes while it changes, and when the world ends). A load can only forget: a
grudge stamped later than the game clock now (another playthrough) or older than 60 game days is dropped.

The recorder is shared with Street reputation. With only Revenge ambushes on, deeds are recorded but no reputation is sent to any character. With both off,
nothing is loaded, hooked or written.

## The squad

`mod/revenge-ambush-world.lua` holds the game calls. It touches **no character of the game**: the fighters are new copies made through the
`DynamicEntitySystem` (not persistent, not always spawned, tagged `CyberpunkConvaiAmbusher`).

1. A hidden, walkable spot V can reach: the invitation code's own spot search (`findVisitorSpot`, up to 70 m out, then nearer, then in sight), a few queries a second.
2. The fighters are created side by side on that spot.
3. Each is made hostile to V and told to fight with the two calls the NPC reactions already use.
4. When a member is within 28 m of V, the nearest one speaks once (below). A squad that stops short still gets its line after 20 s.
5. When the squad is dead, left behind or timed out, the dead are removed after a pause and the living go once they are out of V's sight.
6. A world ending (load, fast travel, death, shutdown) writes the grudge and drops every reference without a native call. The next session also removes any
   tagged leftover once. Turning the setting off removes a standing squad at once.

## The threat

`bridge/ambush-context.mjs`: a private automatic turn of an **ordinary NPC** of the gang (its archetype profile and voice, for example `npc-maelstrom-male`), with
`reaction = {kind: 'ambush', event: 'taunt', group, count, toll, expiresAt}`. No model decision picks the moment. Like a battle bark it is never stored in the
speaker's memory, it is no word of V's, and it is at most 12 words. It goes out only when the channel is free (nothing else is being said or written, V is not
talking), outputs are on, and **Talk to ordinary NPCs** is on. If it cannot go, the squad fights without a line. Gangs: Maelstrom, Tyger Claws, Valentinos,
6th Street, Animals, Voodoo Boys, Scavengers, Wraiths, Mox, Aldecaldos, Barghest.

## Settings > Gameplay (new section)

The gameplay-type options moved out of Conversations and Companion behavior. Only the page changed: every row keeps its stored key and its saved value.

| Row | Was in | Stored key |
|---|---|---|
| Street reputation | Conversations | `reputation` |
| NPCs react to threats and commands | Conversations | `npcThreats` |
| Companions change outfits | Companion behavior | `companionOutfits` |
| Immersive invitations (button to its page) | Companion behavior | `immersive.*` |
| Housemates (button to its page) | Companion behavior | `housemates.*` |
| Revenge ambushes (new) | – | `revengeAmbushes` |

Conversation and voice settings stay where they were. Companion behavior keeps Eye contact height and Head tracking strength.

## Cost

The setting off: one boolean on the existing 0.1 s tick, no module loaded. On: the tick subtracts the elapsed time from one counter and does nothing until its
period is up (30 s idle, 1 s only while a squad is placed or fights). The grudge is one table update per kill. No hook of its own, no update function.

## Files

`mod/revenge-ambush.lua` (decisions), `mod/revenge-ambush-world.lua` (game calls), `mod/init.lua` (`convaiAmbush*`: module, tick, taunt request and delivery),
`mod/reputation.lua` (`onDeed`), `bridge/ambush-context.mjs`, `bridge/protocol.mjs` and `bridge/battle-context.mjs` (the turn). Tests:
`bridge/revenge-ambush.test.mjs` (decisions, grudge, saving, cleanup), `bridge/ambush-context.test.mjs` (the turn).

## Not yet seen live

Everything above is checked offline only. To check in the game (Revenge ambushes on, a gang with at least 6 witnessed kills, calm outdoors):

1. A squad appears out of sight, runs at V, and one member's line is heard and shown (the log shows `Ambush sent` and `Automatic ambush taunt`).
2. The fighters' records (`gang_retaliation_enemies_*`) exist in the installed game: the log says `no fighter record found` if not.
3. The squad is removed afterwards and nothing is left standing (`Revenge ambushes: removed N fighter(s)` only after a CET reload).
4. Nothing comes in a fight, indoors, in a vehicle or while wanted.
