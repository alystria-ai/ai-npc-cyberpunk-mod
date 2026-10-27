# Ordinary NPCs react to threats and obey commands

Written 2026-10-26 on branch `feat/npc-threats-commands` (from `main` 8006a09d) for the next version, not 0.3.2, merged into `integration/0.3.3`.
Reworked 2026-10-27 on `fix/threats-live` after the first live test (next section): the crowd flight's crash, **the game decides** (the owner's
rule), and lethal phrasings. Committed, NOT merged, NOT pushed, offline-tested only. Behind a Companion Manager switch that is **off by default**:
Settings, Conversations, "NPCs react to threats and commands".

## Live test 1 (game 2.5, 2026-10-26) and what changed

| Seen live | Cause | Fix (`fix/threats-live`) |
|---|---|---|
| `NPC reaction: fear failed: npc-reactions.lua:344: attempt to index local 'stim' (a nil value)`, then "the crowd's own flight is not available for leave; the person stays": a walking pedestrian kept walking | `StimuliEvent` is a **native** class (`stimuliEvents.script`: `import final class StimuliEvent`). CET's `NewObject` finds a native class only by its native name (`senseStimuliEvent`), never by its script alias, and returns nil for any other name. The rest of the mod already uses native names (`gameMountEventData`, `enteventsSetVisibility`); `DelayedCrowdReactionEvent` is a script class, so its name worked. The test fake accepted any listed name, so it never returned nil. | The stimulus is made with the type's own constructor `StimuliEvent.new()` (CET resolves script names there, as `EntityID.new()`), then `NewObject('senseStimuliEvent')`; neither: an error. A second way that needs no stimulus at all, **the crowd's fear stage** (below), runs when the event cannot be sent, and once more when a fleeing person has not moved 1.5 m by the 3 s read-back. Never a move command. The fake `NewObject` now returns nil for anything but a known native or script name, as CET does. |
| `screen=insult` / `screen=hurt` with the fight kinds offered, but `tag=none(no-action-requested)` (Convai) and `tag=none(no-tag)` (text) every time | the model never chose a reaction | **The owner's decision: the game decides, not the model** ("Who decides" below). |
| "I'll put a bullet in your head" read as `screen=hurt` | most likely the question tag: a sentence ending in "?" ("..., understand?", "..., you hear me?") was taken as a question, which refuses the kill and kept a lesser reading elsewhere in the message; the log has codes only, so the exact words are not known | question tags no longer make a question; many more lethal phrasings in English and the 15 languages count as death threats ("Lethal phrasings" below) |

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

The crowd event needs a stimulus object, which the first build could not make from CET (live test 1, above). So there are two ways, in order:

1. **The crowd reaction event** (`natives.crowdFear`): `DelayedCrowdReactionEvent` with a `StimuliEvent` from `StimuliEvent.new()` (or
   `NewObject('senseStimuliEvent')`), type `Terror`, V as the source.
2. **The crowd's fear stage** (`natives.crowdPanic`), the public calls `OnCrowdReaction` itself makes, in its order: the crowd member's
   `SetThreatLastKnownPosition(V)`, `AllowWorkspotsUsage(false)`, `NPCPuppet.ChangeHighLevelState(Fear)`, the `panic` (or `fear`) animation wrapper
   and a fear-locomotion wrapper, the `CrowdRunningAway` animation feature (phase 3), a workspot's own `Fear` reaction or its fast exit, and
   `CrowdMemberComponent.ChangeFearStage(Panic | Alarmed, true)`: the crowd system runs a panicked member along its own lanes.

The second way runs when the first cannot be sent, and once more when a person who should flee has moved less than 1.5 m by the 3 s read-back
(`... did not move; asked again with the fear stage`). Only when both are switched off after three failures each does the crowd person **stay**
(`neither the crowd's reaction event nor its fear stage is available ...`): a move command would make it vanish.

## Who decides: the game (the owner's rule of 2026-10-26)

In live test 1 the model never chose a reaction on any provider. The rule since then: **when the screen reads V's words as a death threat, a threat
to hurt, an insult or one of the three commands, and the person's kind allows a reaction for it, the GAME picks the reaction** from the person's
kind and temper, and the model is only told what the person does so that its line fits ("you attack V with your fists"). The model's own choice (the
tag, the Convai action) is left only for words the screen does not read.

- **The plan** (`mod/npc-reactions.lua` `M.plan`): with the switch on, each offer carries the game's pick for every reading at once, `plan = {kill,
  hurt, insult, get-down, stop, exit-vehicle}` -> one allowed kind. It is made at the offer because the words are often heard only later (a voice
  turn). It is **seeded by the person** (`M.seed` of its entity id): the same person reacts the same way every time; two civilians may differ.
  Each row of `M.TEMPERS` is `{kind, weight}`: the seed picks among the weighted kinds; when the pick is not allowed now (a safe zone, V already
  wanted), the next allowed kind of the row stands in (weight 0 = only a stand-in). Logged in the offer line: `plan=kill:attack,hurt:brawl,...`.
- **The pick** (`bridge/companion-actions.mjs` `planReaction`): the screen's reading names the row. A threat and a command at once ("get down or I'll
  shoot"): a person whose plan answers the threat with a fight fights; anyone else does as told.
- **As soon as the words are known**, on every provider:

| Turn | Where the words are read and the pick handed over |
|---|---|
| typed, any provider | the bridge at admission (`CompanionActions.admit`): handed over at once (`by: 'game'`), before the reply is written |
| spoken, Mistral / Local AI / Custom | the text host (`reactionMenu(offer, {heard})`), from the transcript, before the reply is written |
| spoken, Convai | the realtime page, the moment Convai's recogniser finalises V's words (`CompanionActionWindow.decide`, on the final `user-transcription` row); the window then closes, so the model has no action of it left |

- **What the model is told**: a decided turn: "The game has decided what you do as you answer V's new message: you attack V with your weapon. Say
  what you say as you do it ... No action and no tag for it." A Convai voice turn (words not heard yet): the plan for each reading ("if it
  threatens to kill you, you attack V with your weapon; if it insults you, you attack V with your fists; ..."), so the reply Convai writes as soon as
  it hears V fits what the game does.
- The game still starts the reaction **after the reply has been heard** (the lease and `S.start`/`S.update`, as before), and every rail still
  applies at the hand-over and at the start: only ordinary people (never story or quest characters, scenes, rides, companions, children), safe
  zones and the cooldown for fights and police calls, one reaction per person, the command cooldown.
- The bridge accepts a `by: 'game'` pick only if it is the decided kind, or (words not heard yet) one of the plan's kinds; a model's own request
  only among the kinds left to the model. The packet echoes the game's offer with its plan, byte for byte (the lease compares it).
- The turn's line says who chose: `... tag=attack delivered=yes screen=kill by=game` (or `by=model`).

### Decision table (`M.TEMPERS`; weights in brackets, a stand-in in italics)

| Person (`M.temperOf`) | Death threat | Threat to hurt | Insult | Commands |
|---|---|---|---|---|
| ganger, soldier, merc (aggressive or neutral temper): `fighter` | attack with a weapon (*brawl*, *leave*) | brawl with fists (*attack*, *leave*) | brawl (*leave*) | obeys get down, stop, get out |
| ganger, soldier (passive temper): `wary` | cower (1) or leave (1) | leave (*cower*) | leave | obeys |
| NCPD, corporate security: `guard` | attack (*brawl*, *call-police*) | brawl (*attack*, *call-police*) | brawl (*call-police*) | never (not offered) |
| residents, Biotechnica and Trauma Team staff: `civilian` | cower (4), run (4), call the police (2) | run (5), cower (3), police (2) | run (8), police (2) | obeys |
| vendors: `shop` | duck (1) or call the police (1) | police (1) or duck (1) | police (*duck*) | get down only |
| Aldecaldos: `nomad` | walk off | walk off | walk off | obeys |

"Run" is `leave` (a crowd person flees with the crowd's own fear), "duck" and "cower" are `cower`.

## The screen of V's words

1. **V's words** (`bridge/threat-screen.mjs`, `screenMessage`): the line reads as a death threat (`kill`), a threat to hurt or a fight challenge
   (`hurt`), an insult at the person (`insult`), or one of the three commands. Refused, with the reason in the log: a joke marker (`lol`,
   "just kidding", `шучу`, `jaja`, `ㅋㅋ`, `开玩笑`...; a denied one like "I'm not joking" does not count as one), words inside quotation marks, a question
   ("would you kill for money?", "should I shoot you?"), a denial ("I won't hurt you", "я тебя не убью"). English needs the nearest subject before
   the verb to be "I" or "we" ("my boss will kill me", "they'll kill you" are not V's threats); the other languages are matched in their first-person
   and imperative forms. All 16 languages (English and the 15 menu languages) are read at once. A question tag at the end ("..., understand?",
   "..., you hear me?", "verstanden?", "понял?") does not make a threat a question.
2. With the plan (above) a clear reading decides. For words the screen does not read, or an offer without a plan, the model's own judgement in its
   reply chooses as before: the tag the reply opens with (text routes) or the action it requests (Convai).

### Lethal phrasings (2026-10-27)

Death threats, not threats to hurt, in English: a bullet (a round, one, two, a hole) in, through or between "your head / skull / eyes / chest";
"shoot you in the head / face / heart"; "blow your brains out / head off"; "you're dead", "as good as dead", "consider yourself dead", "dead man
walking"; "end you", "flatline you", "zero you", "geek you", "smoke you", "waste you", "ice you"; "put you in the ground / six feet under / in a
grave", "you'll be six feet under"; "cut / slit your throat", "break / snap your neck"; "you won't leave here alive", "have you killed". In the 15
languages the same set where the language has it (a bullet in the head, brains blown out, buried or put under the ground, "you're finished / it's
over for you"), for example "ich jag dir eine Kugel in den Kopf", "je vais te faire sauter la cervelle", "te voy a volar los sesos", "я тебе мозги
вышибу", "頭をぶち抜いてやる", "머리를 날려버릴 거야", "我要爆你的头". Still not threats: "I'll end you in chess", "I'll put you in the car", "you're dead to me",
"я закопаю клад", "저세상 텐션", "heute ist dein letzter Tag im Büro".

Without a plan the words only **narrow the offer** (`screenedKinds`); they never start anything:

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

The same places as the game's pick ("Who decides"). For the model's own fallback choice a Convai voice turn keeps only the kinds that need no
words (`leave`, `call-police`); the plan covers the rest once the page has the final transcript.

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

Which of them a clear reading of V's words gets is the game's plan (the decision table above); the model chooses only for words the screen does not read.

## What the game does

All from CET, every call guarded (`pcall`), logged once per failure kind, switched off for the session after three failures. Names checked
against the game's compiled script cache (`r6/cache/final.redscripts`, read-only, 2026-10-26) and the item record against `tweakdb.bin` by its hash.

| Kind | Crowd person | Anyone else | Status |
|---|---|---|---|
| leave | `DelayedCrowdReactionEvent` (phase 3), `StimuliEvent.new()` (or `NewObject('senseStimuliEvent')`) from V of type `Terror` with its record (`StimuliSystem.GetStimRecord`), `npc:QueueEvent`; else, or when it did not move the person, the crowd's fear stage (`ChangeFearStage(Panic)` and the calls above) | `AIMoveToCommand`, as before | crowd: **unconfirmed** (live test 1 crashed on `NewObject('StimuliEvent')`, fixed); walk: live |
| cower, get-down | the same event, phase 2 (cowers or surrenders; seated people use the seat's own fear); else the fear stage `Alarmed` | `AIHoldPositionCommand` 20 s (holds still) | **unconfirmed** / live |
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
- `NPC reaction offered: kinds=... type=<base> message=<n> threats=on temper=<aggressive|passive|neutral|?> plan=<reading:kind,...|->` (the tail only
  with the switch on)
- `NPC reaction: leave started, the crowd's own flight (the crowd reaction event, no move command)` or `(the fear stage, no move command)`,
  `... cower started, the crowd's own fear (...)`, `... get-down started, holds still for 20 s (...)`, `... stop started, holds still for 30 s`,
  `... brawl hostile ok, combat start ..., fists fists asked`, `... exit-vehicle started, the game's own exit`
- the read-backs above; `NPC reaction: leave did not move; asked again with the fear stage (sent)`; `NPC reaction: fear failed: ...` /
  `panic failed: ...` (once each); `neither the crowd's reaction event nor its fear stage is available for leave; the person stays`

`bridge.stderr.log` (`[NPCReaction]`): the turn's one line gains ` screen=<code>` for a threats offer: `kill`, `hurt`, `insult`, `get-down`, `stop`,
`exit-vehicle`, `insult+stop`, `none`, `none(joke|quote|question|negated)`, `unheard` (a voice turn: the words are read later). Codes only, never V's
words. `offered=` is then what this turn may hand over; `admitted=no(screened)` means nothing. A chosen kind ends with ` by=game` (the plan) or
` by=model` (a tag, a Convai action).

## Files

| File | Role |
|---|---|
| `bridge/threat-screen.mjs` (new) | the screen of V's words, 16 languages, lethal phrasings, question tags; `screenedKinds` |
| `mod/npc-reactions.lua` | kinds per person with the switch, the game's plan (`M.plan`, `M.TEMPERS`, `M.seed`), the rails (vehicle, command cooldown, brawl), the natives (crowd fear event, crowd fear stage, hold, fists, holster, hand, exit, mount reads), the crowd flight fix, the read-backs |
| `bridge/realtime-client.mjs` | the Convai page: the plan decides on the final transcript of a voice turn |
| `mod/manager.lua`, `mod/manager-ui.lua`, `mod/init.lua` | the setting `npcThreats` (off by default), its row, the `threats` option |
| `mod/gameplay-actions.lua` | the lease takes up to 8 kinds |
| `bridge/companion-actions.mjs` | the offer's `threats` flag, its plan and five kinds, the game's pick (`planReaction`, `decideReaction`) and its hand-over at admission, the `by: 'game'` message, narrowing for the model's fallback, the Convai actions, window (`decide`) and words, the trace's `screen` and `by` |
| `bridge/text-actions.mjs`, `bridge/text-provider-host.mjs` | a decided menu (no tag, the note of what the person does, the pick from the transcript handed over before the reply), `[cower]` and `[obey]`, `[attack]` as brawl or attack, the menu narrowed by the transcript, the notes |
| `mod/locales/*.lua`, `localization/en.json` | the setting's label and help in all 15 languages |
| `packaging/runtime-layout.mjs`, `packaging/release-plan.json` | ship `bridge/threat-screen.mjs` |
| `bridge/threat-screen.test.mjs`, `bridge/npc-threats.test.mjs`, `bridge/npc-threats-decide.test.mjs`, `bridge/npc-threats-lua.test.mjs`, `bridge/npc-reaction-pipeline.test.mjs`, `bridge/realtime-client.test.mjs` | the tests |

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

Added 2026-10-27 (`fix/threats-live`):
- `bridge/threat-screen.test.mjs` (+4, 28): lethal phrasings in English (37 lines) and the 15 languages (four each), what only sounds lethal, and
  question tags against real questions.
- `bridge/npc-threats-lua.test.mjs` (+5, 20): the stimulus is never asked of `NewObject` by its script name (the fake returns nil for unknown
  names, as CET does), the native name alone works, neither sends nothing; the crowd fear stage's exact calls (phase 3, phase 2 in a workspot,
  phase 3 in a workspot, a refused stage); the event failing falls back to the fear stage, an event that did not move the person is followed once by
  the fear stage, both switched off is the honest stay with no walk; the plan per kind and temper, its stand-ins, its seed (400 civilians: a mix,
  the same for one person, never a fight), the offer's plan and log line.
- `bridge/npc-threats-decide.test.mjs` (new, 8): the plan in the offer and its validation; the pick (a threat and a command at once); a typed turn
  decided and handed over at admission, the model unable to change it, the text menu's note; the fallback for unread words; a Convai voice turn
  (the window's plan text, `decide` on the words, once, the model's own fight refused); a spoken text-route turn decided from the transcript; game
  picks outside the plan refused; the decided window publishes no action.
- `bridge/realtime-client.test.mjs` (+1): a Convai voice turn on the real page: a streaming segment decides nothing, the final transcript hands over
  `{reaction: 'attack', by: 'game'}` once, and the model's later action finds the window closed.
- `bridge/npc-reaction-pipeline.test.mjs` (the threats test rewritten): the plan travels from the real Lua offer, the bridge decides "get down" at
  admission and hands it over before the reply, the model is told, the trace says `by=game`, and the lease takes the echo with the plan.

## Live test (owner)

Live test 1 (2026-10-26, game 2.5) found the three problems at the top. Live test 2 is this one, for `fix/threats-live`.

Install: overlay the committed `mod/` and `bridge/` files of the branch (never `mod/diagnostics.lua`), CET reload, bridge restart (no redscript, no
game restart). Use a throwaway copy of a save. Keep `probe.log` and `bridge.stderr.log` open. Every offer line now ends with `plan=...`: that is
what the person WILL do for each reading, so read it before typing and check that the person does exactly that. Typed lines first (any provider),
then step 10 by voice.

1. **Switch off (the default), the old reactions.** In Watson, type to a pedestrian on a bench: "get out of my sight or I'll kill you". Expect the
   old offer line (no `threats=on`, no `plan=`). If the model makes it leave: `leave started, the crowd's own flight (the crowd reaction event, no
   move command)` (or `(the fear stage, ...)`), then `leave crowd moved=<m> m in 3 s` with more than a couple of metres. **Does the person get up and
   run, rather than vanish or stay?** No `fear failed: ... 'stim' (a nil value)` line any more.
2. Turn the switch on: Settings, Conversations, "NPCs react to threats and commands".
3. **A walking pedestrian, a death threat** (the live test 1 failure). Type "I'll put a bullet in your head" to someone walking past. Expect
   `threats=on temper=... plan=kill:<cower|leave|call-police>,...`, the bridge line `... tag=<that kind> delivered=yes screen=kill by=game`, and the
   reply in character with it (scared, begging or "I'm calling the cops"). If the plan says `leave`: `leave started, the crowd's own flight (...)` and
   **does the person visibly run off** (not vanish, not keep walking)? If it says `did not move; asked again with the fear stage`, note whether the
   second ask made it run. If `cower`: **does the person crouch and cover?**
4. **The same person again, the same words** after reloading the save: **the same reaction** (seeded by the person, not random).
5. **A civilian, a command.** "Get down on the ground!" to another pedestrian. Expect `screen=get-down ... by=game` and `get-down started`. **Does the
   person crouch or cower and stay?**
6. **Stop.** "Freeze! Don't move." Expect `stop started, holds still for 30 s ... by=game`. Walk away 10 m after the talk: **does the person stay put
   for about half a minute?**
7. **A ganger, an insult.** In Northside, "you're a worthless piece of shit" to a Maelstrom or 6th Street ganger (not in a safe zone). An aggressive
   or ordinary ganger's plan says `insult:brawl`: expect `screen=insult ... tag=brawl ... by=game`, `brawl hostile ok, combat start ..., fists fists
   asked`, `brawl in_combat=true hostile_to_v=true hand=<...>`. **Does he come at V with his fists, and say something that fits?** If `hand=` names a
   gun, the next line says it asked him to put it away: **does he?**
8. **A ganger, a death threat.** Another ganger: "I'll put a bullet in your head, understand?". Expect `screen=kill` (not `hurt`, not
   `none(question)`), `tag=attack ... by=game`. **Does he draw his weapon?** Also try "I'll blow your brains out" and "you're dead" on others.
9. **A cop, a calm line then an insult.** "Evening, officer, nice night.": `admitted=no(screened)`, nothing happens. Then (not in a safe zone, with
   a save you can lose) "you corrupt piece of shit" to another officer: `plan=kill:attack,hurt:brawl,insult:brawl`, `tag=brawl by=game`: **fists**.
10. **Convai voice** (provider Convai, talk key). Say "I'll put a bullet in your head" to a ganger whose plan says `kill:attack`. Expect the bridge
    line `... route=convai tag=attack delivered=yes screen=unheard by=game`. **Does he draw as soon as his reply is spoken, and does the reply fit?**
    Then the same on a pedestrian: does it flee or cower as its plan says?
11. **Spoken, Local AI or Mistral** (the local microphone): "Get down!" to a pedestrian: `screen=unheard ... tag=get-down by=game`.
12. **Get out of the vehicle.** On foot, to an ordinary driver stopped at a light: "Get out of the car!". Expect `kinds=exit-vehicle`,
    `plan=exit-vehicle:exit-vehicle` and `exit-vehicle out of the vehicle`, or `not offered: game-in-charge:driven` (note it). **Can V talk to a
    driver at all?**
13. **Refusals and fallback.** "I'll kill you lol" and 'He said "get down"': `screen=none(joke)`, `screen=none(quote)`, no `by=game`, nothing
    happens. "Nice jacket": the model's own choice as before (`by=model` if it chose anything).
14. **Russian**: "Ложись!" and "Я тебе мозги вышибу" to pedestrians: `screen=get-down`, `screen=kill`, both `by=game`.
15. **Frame rate.** With the switch on, talk to a few people in a crowded street; FPS as before (nothing runs between turns).

What only this can confirm: whether `StimuliEvent.new()` (or the native name) makes the stimulus in CET, whether the crowd's fear stage alone makes
a pedestrian run, the fists command on an ordinary NPC, the exit event, and whether a Convai voice reply fits the planned reaction.

## Open risks

- The crowd event, the fists command and the exit event are called from CET for the first time. Each is guarded and logged; a missing one loses
  only that outcome (a crowd person then gets the fear stage instead, and stays only when that fails too; a brawl is a plain fight, a get-out does
  nothing). Whether the fear stage alone makes a walking pedestrian run is unconfirmed (live test 2, step 3).
- The game shares a crowd person's fright with bystanders within about 10 m (its own `SpreadFear` when the source is V). A "get down" in a busy
  street may scatter the people around; that is the game's own behaviour when V threatens someone.
- The words screen now decides: a false match (a line it reads as a threat that is not one) makes the person react as its plan says. It is
  tuned against the lines that only sound violent (tests); a rare lethal phrasing it misses leaves the model its old choice.
- A Convai voice reply is written by Convai as soon as it hears V, from the plan in its context; if it ignores it, the game still does what the
  plan says (the line may then not fit).
- The game decides from the reading, not from the reply: a person whose reply refuses still reacts (the decided note tells the model not to refuse).
