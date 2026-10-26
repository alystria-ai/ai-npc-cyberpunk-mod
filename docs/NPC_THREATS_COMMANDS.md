# Ordinary NPCs react to threats and obey commands

Written 2026-10-26 on branch `feat/npc-threats-commands` (from `main` 8006a09d) for the next version, not 0.3.2. Committed, NOT merged, NOT pushed,
offline-tested only. Behind a Companion Manager switch that is **off by default**: Settings, Conversations, "NPCs react to threats and commands".

It extends the reactions of ordinary NPCs (docs/NPC_REACTIONS.md: leave, call the police, attack) and keeps every rail of that feature. Read that
document first; this one only says what is new.

## The request

A player (YamiGenesis, Nexus) asked for two things, and the owner wants them built:

1. NPCs respond to threats: they run or fight depending on who they are; **fists for insults, weapons for death threats**.
2. NPCs obey commands such as "get down", "stop", "get out of the vehicle", if their personality allows.

A second player (Shandor, Discord, report r-20261026-002345) said that when he threatened a street NPC, "instead of running they just disappear".
That is a bug of the existing `leave` reaction, found and fixed here (next section). The fix is **not** behind the switch: it changes how an existing
reaction runs, not what is offered.

## The "disappears instead of running" bug

Evidence (`deliverables/player-reports/shandor-2026-10-26/extracted/logs/01-probe.txt`), the same three times:

```
17:34:22Z Focus class: actor=10311175ULL crowd=true civilian=true workspot=true      (each person: a crowd member on a bench or corner)
17:35:10Z NPC reaction: leave started, run away (31 m from V)
17:35:12Z NPC reaction check: leave command state=Success                            (1.2 s after the start)
17:35:13Z Crowd movement after gaze release: actor=10311175ULL metres_moved=30.029644052725
17:49:24Z NPC reaction: leave started, run away (31 m from V)
17:49:25Z NPC reaction check: leave command state=Success
17:49:27Z Crowd movement after gaze release: actor=9009681ULL metres_moved=29.999999550703
```

`awayFar` is 30 m and the walkable point found there was the raw target (the snap moved it by nothing), so the person ended **exactly** on the
command's end point: 29.9999996 m. A run covers 5 to 6 m a second; 30 m in under 3 s with the command already `Success` at 1.2 s is not a run.
**The game moves a crowd person given an `AIMoveToCommand` to the end point at once.** The player sees the person vanish (it reappears 30 m away, out
of sight, and the crowd system later removes it). Our own companions take the same command and walk, because they are not crowd members.

Fix (`mod/npc-reactions.lua`): a crowd person (`npc:IsCrowd()`) never gets a move command. It gets **the crowd's own fear**: the
`DelayedCrowdReactionEvent` that the game's reaction component handles (`reactionComponent.script` `OnCrowdReaction`), queued on the person with a
fixed fear phase, exactly as the game itself queues it to the passengers of a car (`vehicles.script` `TriggerFearInsideVehicleBehavior`,
`TriggerExitBehavior`). Phase 3 runs away along the crowd's own paths (or gets out of its seat first: the workspot exit is part of that handler),
phase 2 cowers or surrenders where it is. The game then plays its own fear voice and animations, lets bystanders within about 10 m share the fright
(its `SpreadFear`, as when V draws a gun) and later removes the person out of sight (`MarkDespawnCandidate`), as it does for every frightened
passer-by. Anyone who is not a crowd member still walks with the move command, as before.

New read-backs: `NPC reaction check: leave crowd moved=<m> m in 3 s` (the crowd flight) and, for a walk, `... command state=<s> moved=<m> m`,
with `(jumped, not walked)` when the first read-back finds more than 12 m.

If the crowd event cannot be sent (missing class, three failures switch it off), the crowd person **stays**: a move command would make it vanish.

## The two keys: no fight on a calm line

A reaction that hurts V or obeys V needs **both**:

1. **V's words** (`bridge/threat-screen.mjs`, `screenMessage`): the line reads as a death threat (`kill`), a threat to hurt or a fight challenge
   (`hurt`), an insult at the person (`insult`), or one of the three commands. Refused, with the reason in the log: a joke marker (`lol`,
   "just kidding", `шучу`, `jaja`, `ㅋㅋ`, `开玩笑`...; a denied one like "I'm not joking" does not count as one), words inside quotation marks, a question
   ("would you kill for money?", "should I shoot you?"), a denial ("I won't hurt you", "я тебя не убью"). English needs the nearest subject before
   the verb to be "I" or "we" ("my boss will kill me", "they'll kill you" are not V's threats); the other languages are matched in their first-person
   and imperative forms. All 16 languages (English and the 15 menu languages) are read at once.
2. **The model's own judgement** in its reply: the tag the reply opens with (text routes) or the action it requests (Convai), exactly as for the
   existing reactions.

The words only **narrow the offer** (`screenedKinds`); they never start anything:

| Kind | Needs in V's words |
|---|---|
| `leave`, `call-police` | nothing new: the model's choice alone, as before this feature |
| `attack` (with a weapon) | a death threat |
| `brawl` (with fists) | a threat to hurt, a fight challenge or an insult |
| `cower` | a death threat or a threat to hurt (nobody cowers at an insult) |
| `get-down`, `stop`, `exit-vehicle` | that command |

So a cop on a calm line is offered nothing at all (the turn's line says `admitted=no(screened)`), and a model that writes `[attack]` anyway hands
nothing over. With the switch on, `attack` also needs the death threat: the model alone never starts a fight. With the switch off, nothing here runs and
the reactions are exactly as before (the screen is not even called).

The model sees **one fight tag** (`[attack]`, Convai `Attack V`) and **one obey tag** (`[obey]`, Convai `Obey V`): the words already decided whether the
fight is with fists or a weapon and which command was given, and the offer never holds both fights or two commands. `[cower]` (Convai `Cower`) is its own.

### Where the words are read

| Turn | Narrowed by |
|---|---|
| typed, any provider | the bridge at admission (`CompanionActions.admit`), from the typed text |
| spoken, Mistral / Local AI / Custom | the text host (`reactionMenu(offer, {heard})`), from the transcript |
| spoken, Convai | **not available**: Convai hears the voice itself and its words arrive after its reply, so a Convai voice turn keeps only `leave` and `call-police` (fail closed) |

Follow-up for Convai voice (not built): screen the final user transcription inside the realtime page before the action window accepts a proposal.

## Who does what (personality)

`mod/npc-reactions.lua` `M.kindsFor(archetype, threats, temper)`. The archetype is the one every ordinary NPC turn already carries
(docs/NPC_ARCHETYPES.md); the temper is the game's own reaction preset of the person (`GetStimReactionComponent():GetReactionPreset():Type()`:
`Ganger_Aggressive`, `Ganger_Passive`, `Civilian_Neutral`, ...), read once per offer with the switch on.

| Kind of person | Before (and with the switch off) | Added with the switch on |
|---|---|---|
| Residents (corporate worker, street local, nomad, rough sleeper, club-goer, city worker, Dogtown) | leave, call-police | cower, get-down, stop, exit-vehicle |
| Vendors | call-police | cower, get-down (a clerk ducks; never walks off its post, never fights) |
| NCPD | attack | brawl (a cop never takes orders from V) |
| Corporate security | call-police, attack | brawl (never takes orders); cower when passive |
| Gangs, factions (Militech, Kang Tao, NetWatch, mercs, goons) | leave, attack | brawl, get-down, stop, exit-vehicle; cower when passive |
| Aldecaldos | leave | get-down, stop, exit-vehicle (they walk off rather than fight) |
| Biotechnica, Trauma Team | leave, call-police | cower, get-down, stop, exit-vehicle |

Run or cower for a civilian, comply or refuse for anyone, is then the model's choice in character, from what the game offered.

## What the game does

All from CET, every call guarded (`pcall`), logged once per failure kind, switched off for the session after three failures. Names checked
against the game's compiled script cache (`r6/cache/final.redscripts`, read-only, 2026-10-26) and the item record against `tweakdb.bin` by its hash.

| Kind | Crowd person | Anyone else | Status |
|---|---|---|---|
| leave | `DelayedCrowdReactionEvent` (phase 3), `StimuliEvent` from V of type `Terror` with its record (`StimuliSystem.GetStimRecord`), `npc:QueueEvent` | `AIMoveToCommand`, as before | crowd: **script** (unconfirmed from CET); walk: live |
| cower, get-down | the same event, phase 2 (cowers or surrenders; seated people use the seat's own fear) | `AIHoldPositionCommand` 20 s (holds still) | **script** / live |
| brawl | hostile + combat start as `attack`, then `AIEquipCommand` of `Items.w_melee_004__fists_a` to `AttachmentSlots.WeaponRight` (`failIfItemNotFound` off: nothing is added to the inventory); after 1.2 s, if the hand holds a weapon, one `AIUnequipCommand` | same | combat: live; fists: **unconfirmed** |
| attack | unchanged (a weapon) | same | live |
| stop | `AIHoldPositionCommand` 30 s, **without** letting go of the conversation (the talk goes on; the hold outlasts the conversation's own) | same | live (the conversation hold is the same command) |
| exit-vehicle | `AIEvent` named `ExitVehicle` queued on the person: the passenger exit the game itself queues (`vehicles.script` `TriggerExitBehavior`) | same | **script** |

Read-backs, one each: `crowd moved=<m> m in 3 s`, `hold state=<s>`, `brawl in_combat=... hostile_to_v=... hand=<fists|empty|record>`,
`exit-vehicle out of the vehicle | still in the vehicle`.

Not used: `VehicleObject.TriggerExitBehavior` (it would queue a crowd fear event with no stimulus to every passenger), the stimulus broadcast
`SendDrirectStimuliToTarget` (the game decides the reaction from tags we cannot see), the "Weapon Glitch" quickhack status for fists (sparks and a
hack on V's record).

## Allowed for game-placed characters

The standing rule: a game-placed character gets talk, face and audio only; the one approved exception is the ordinary street NPC's reaction
(docs/NPC_REACTIONS.md, 2026-10-21). This feature stays inside that exception:

- **Only ordinary NPCs**: the same `M.allowed` rails. Never our companions, another mod's characters, a named, story or quest character (record flag
  or the runtime `IsQuest`), never a child.
- **Never while the game is in charge**: a scene, a quest dialogue, a call, a fight, an injury (`mod/world-talk.lua`). A person **in a vehicle** is
  refused everything except `exit-vehicle`, and that only while V herself is on foot (`IsMountedToAnything` on V). A driven (scripted) driver is
  still refused (`driven` comes first).
- **V's companions**: never offered any of this. Their own actions already cover crouching with V and leaving a car (docs/COMPANION_*.md).
- **Nothing permanent**: no inventory change (the fists command adds nothing), no attitude change except the existing `attack`/`brawl` hostility,
  no world object touched. A frightened crowd person is removed later by the game, as any frightened passer-by.

## Rate limits

- Once per person: a reaction (leave, call-police, attack, brawl, cower) is the person's one reaction until the save is reloaded, as before.
- A **command** is not that one reaction: a person told to stop may still run off when threatened. Commands have their own 30 s cooldown per person
  (`commandCooldown`); nobody obeys after it ran off.
- Brawl joins attack and call-police in the 120 s cooldown for everyone, and in the safe-zone, already-hostile and attack-switched-off rails.

## Speed and frame rate

Nothing per frame. The screen runs once per turn of a person with a threats offer (a few dozen regular expressions over one message, under a
millisecond; a long message under 15 ms in the test), never otherwise. The switch is read once per offer. The natives are asked at the offer (the
temper, V's seat for a person in a vehicle), once at the start and once at the read-back.

## The logs

`probe.log`:
- `NPC reaction offered: kinds=... type=<base> message=<n> threats=on temper=<aggressive|passive|neutral|?>` (the tail only with the switch on)
- `NPC reaction: leave started, the crowd's own flight (no move command)`, `... cower started, the crowd's own fear (no move command)`,
  `... get-down started, holds still for 20 s (...)`, `... stop started, holds still for 30 s`, `... brawl hostile ok, combat start ..., fists fists asked`,
  `... exit-vehicle started, the game's own exit`
- the read-backs above; `NPC reaction: the crowd's own flight is not available for leave; the person stays`

`bridge.stderr.log` (`[NPCReaction]`): the turn's one line gains ` screen=<code>` for a threats offer: `kill`, `hurt`, `insult`, `get-down`, `stop`,
`exit-vehicle`, `insult+stop`, `none`, `none(joke|quote|question|negated)`. Codes only, never V's words. `offered=` is then what the words left;
`admitted=no(screened)` means they left nothing.

## Files

| File | Role |
|---|---|
| `bridge/threat-screen.mjs` (new) | the screen of V's words, 16 languages; `screenedKinds` |
| `mod/npc-reactions.lua` | kinds per person with the switch, the rails (vehicle, command cooldown, brawl), the natives (crowd fear, hold, fists, holster, hand, exit, mount reads), the crowd flight fix, the read-backs |
| `mod/manager.lua`, `mod/manager-ui.lua`, `mod/init.lua` | the setting `npcThreats` (off by default), its row, the `threats` option |
| `mod/gameplay-actions.lua` | the lease takes up to 8 kinds |
| `bridge/companion-actions.mjs` | the offer's `threats` flag and five kinds, narrowing at admission, the Convai actions and words, the trace's `screen` |
| `bridge/text-actions.mjs`, `bridge/text-provider-host.mjs` | `[cower]` and `[obey]`, `[attack]` as brawl or attack, the menu narrowed by the transcript, the notes |
| `mod/locales/*.lua`, `localization/en.json` | the setting's label and help in all 15 languages |
| `packaging/runtime-layout.mjs`, `packaging/release-plan.json` | ship `bridge/threat-screen.mjs` |
| `bridge/threat-screen.test.mjs`, `bridge/npc-threats.test.mjs`, `bridge/npc-threats-lua.test.mjs`, `bridge/npc-reaction-pipeline.test.mjs` | the tests |

## Tests

- `bridge/threat-screen.test.mjs` (24): English threats, challenges, insults and commands; what only sounds violent ("I could murder a burger",
  "stop talking", "get out of here", "I'll shoot you a text", "my boss will kill me"); jokes, quotes, questions, denials and denied jokes; every menu
  language (threat, hurt, insult, the three commands, a denial or a negative form, a joke); questions in several languages; `screenedKinds`; speed.
- `bridge/npc-threats-lua.test.mjs` (15): the switch-off kinds are the old ones for every base of `characters/archetypes.json`; the switch-on
  mapping and its invariants; every new rail; the switch-off path (no flag, no new kind, nothing new read, a new kind never starts, an unreadable
  manager is off); dispatch on a fake game for every kind (crowd flight instead of a walk, the stay when the flight cannot be sent, cower and get
  down for crowd and non-crowd, the fear switched off after failures, brawl with fists and the holster, the shared cooldown, stop without release
  and not the one reaction, exit-vehicle and V in a car); nothing per frame; the natives' exact objects on a strict fake game (real Vector4); wiring.
- `bridge/npc-threats.test.mjs` (8): the input keeps the flag; narrowing at admission (calm, insult, death threat, command, Russian, a cop on a calm
  line); spoken turns per route; delivery and the exact echo of the game's offer; the text menu's tags; the notes (the old sentence unchanged);
  the Convai window; a whole Mistral turn: insult + `[attack]` hands over a brawl, a calm line + `[attack]` hands over nothing, a command + `[obey]`.
- `bridge/npc-reaction-pipeline.test.mjs` (+1): "get down" through the real Lua lease, parser, knowledge router, admission, text host and back into
  the lease, with the switch on; then off again, the old offer.

## Live test (owner)

Install: overlay the committed `mod/` and `bridge/` files of this branch (never `mod/diagnostics.lua`), CET reload, bridge restart (no redscript,
no game restart). Use a throwaway copy of a save. Keep `probe.log` and `bridge.stderr.log` open. Provider: Mistral or Local AI, **typed** lines first
(a Convai voice turn keeps only leave and call-police, see above).

1. **Switch off (the default), the old reactions.** In Watson, type to a pedestrian on a bench: "get out of my sight or I'll kill you". Expect the
   old offer line (no `threats=on`), and if it leaves: `leave started, the crowd's own flight (no move command)` then `leave crowd moved=<m> m in 3 s`.
   **Does the person stand up and run, rather than vanish?** (This is the Shandor fix; it is not behind the switch.)
2. Turn the switch on: Settings, Conversations, "NPCs react to threats and commands".
3. **A civilian, a death threat.** Type "I'm going to kill you" to a pedestrian. Expect `offered: kinds=leave,call-police,cower,get-down,stop ... threats=on`,
   the bridge line `screen=kill` with `offered=leave,call-police,cower`. Does the person run (`leave`), cower in place (`cower`, crowd fear phase 2) or
   call the police? Note which and whether it looks like the game's own fear.
4. **A civilian, a command.** Type "Get down on the ground!" to another pedestrian. Expect `screen=get-down`. If the reply complies: `get-down started`
   then for a crowd person the crowd's fear. **Does the person crouch or cower and stay?**
5. **Stop.** Type "Freeze! Don't move." Expect `stop started, holds still for 30 s`. Walk away 10 m after the talk ends: **does the person stay put for
   about half a minute?**
6. **A ganger, an insult.** In Northside, type "you're a worthless piece of shit" to a Maelstrom or 6th Street ganger (not in a safe zone).
   Expect `screen=insult`, `offered=leave,brawl` (and `cower` if passive). If he fights: `brawl hostile ok, combat start ..., fists fists asked`, then
   `brawl in_combat=true hostile_to_v=true hand=<...>`. **Does he come at V with fists?** If `hand=` names a gun, the line after says it asked him to
   put it away: **does he?**
7. **A ganger, a death threat.** Another ganger: "I'll put a bullet in your head". Expect `screen=kill`, `offered=leave,attack`. **Does he draw his
   weapon** (`attack`, never `brawl`)?
8. **A calm line to a cop** (any NCPD officer): "Evening, officer, nice night." Expect the bridge line `admitted=no(screened) ... screen=none` and
   nothing happens, whatever the reply says.
9. **Get out of the vehicle.** Walk up to a parked or stopped car with an ordinary driver (traffic waiting at a light), on foot, and type
   "Get out of the car!". Expect `kinds=exit-vehicle` (the person is in a vehicle) and, if the reply complies, `exit-vehicle started` then
   `exit-vehicle out of the vehicle`. If instead the log says `not offered: game-in-charge:driven` the game drives that driver (traffic): note it.
   **Can V even talk to a driver?** (Untested; the talk target may not pick people in cars.)
10. **Refusals.** "I'll kill you lol" and 'He said "get down"' must give `screen=none(joke)` and `screen=none(quote)` and no fight or command.
11. **Russian** (the player's language): "Ложись!" and "Я тебя убью" to pedestrians: `screen=get-down`, `screen=kill`.
12. **Frame rate.** With the switch on, talk to a few people in a crowded street; FPS as before (nothing runs between turns).

What only this can confirm: the crowd fear event from CET (steps 1, 3, 4), the fists command on an ordinary NPC (step 6), the exit event and
whether a driver can be talked to at all (step 9), and how far the shared fright spreads to bystanders.

## Open risks

- The crowd event, the fists command and the exit event are called from CET for the first time. Each is guarded and logged; a missing one loses
  only that outcome (a crowd person then stays or holds still, a brawl is a plain fight, a get-out does nothing).
- The game shares a crowd person's fright with bystanders within about 10 m (its own `SpreadFear` when the source is V). A "get down" in a busy
  street may scatter the people around; that is the game's own behaviour when V threatens someone.
- The words screen is a gate, not a classifier: a rare phrasing it misses leaves the person with leave and call-police only; a false match only
  widens what the model may choose, it never starts anything.
- Convai voice turns get no fight, cower or command (see "Where the words are read").
