# Ordinary NPCs react to threats and obey commands

Written 2026-10-26 on branch `feat/npc-threats-commands` (from `main` 8006a09d) for the next version, not 0.3.2, merged into `integration/0.3.3`.
Reworked 2026-10-27 on `fix/threats-live` after the first live test (next section): the crowd flight's crash, **the game decides** (the owner's
rule), and lethal phrasings. Reworked again 2026-10-27 on `fix/threats-crowd` after live test 2: walking crowd people taken from the crowd's
traffic before they react, and a brawl that escalates when V does. Reworked again 2026-10-27 on `fix/threats-decide` after live test 3 (switch
off, nothing fired): the game's plan and pick on both sides of the switch, more insults and dares read, and the game's verdict on the turn's line.
Reworked again 2026-10-27 on `fix/threats-live4` after live test 4: the feeling of a decided reaction in the model's note, a "get down" that
keeps a walking person down for its 20 s, and a brawl whose friends are found and whose escalation really puts guns in hands.
Committed, NOT merged, NOT pushed, offline-tested only. The new kinds (cower, fists, the commands) are behind a Companion Manager switch that is
**off by default**: Settings, Conversations, "NPCs react to threats and commands"; the crowd run and the game's pick among the old kinds are not.

## Live test 4 (game 2.31, 2026-10-27, Local AI "lite" + Pocket) and what changed

| Seen live | Cause | Fix (`fix/threats-live4`) |
|---|---|---|
| Switch off, "get lost or I'll kill you" to a walking corpo: he ran, for real (`taken from the crowd and run away in legs (45 m ...)`, `first leg moved=0.7 m in 0.4 s (running)`, `leave ran 30.6 m in 6 leg(s); back to the crowd`), but said "I don't know what's got you so twisted, but you're not scaring me" (`screen=kill game=leave by=game`) | the model's note said only what the person does ("you have had enough of V and get away from V now (you run if you are scared, you walk off if you are not)"): the feeling was left to the model, and a small local model picked the brave one | **the note carries the feeling**, from the reading that picked the reaction: the fact ("V has just threatened to kill you."), the feeling ("You are scared of V."), the deed, and how the line sounds ("frightened: shaky, pleading or panicked. Do not sound calm or brave, and never say V does not scare you."), in short plain sentences a 4B model follows ("The feeling of a decided reaction" below) |
| Switch on, "get down on the ground!" to a walking homeless man: he cowered "only for a second": `get-down started, holds still for 20 s, taken from the crowd before the conversation let go, in the crowd's own fear`, `get-down hold state=Enqueued moved=0.3 m`, `get-down hold over, back to the crowd (moved=39.2 m in the hold)` | the crowd reaction event in phase 2 is, for a person out of the traffic lane, the crowd's **Surrender** reaction (`reactionComponent.script` OnCrowdReaction, `TriggerReactionBehaviorForCrowd(..., gamedataOutput.Surrender, ...)`): a reaction behaviour that outranks AI commands, so our hold waited in the queue (`Enqueued`); the surrender pose lasts a moment, then the crowd's fear stage `Alarmed` (set by the same event) walks the person away and marks it for despawn | **no crowd fear for a held person**: the hold, then the **scared pose** (the same fear animation set the crowd reaction turns on for phase 2, `SetAnimWrapperWeightOnOwnerAndItems(npc, 'fear', 1)`, off again when the hold ends), then the conversation lets go. A hold that is not `Executing` at the first read-back is sent once more for the rest of the 20 s |
| Brawl, Tyger Claws woman, insult: `brawl joined by 0 more` although three friends came; two drew guns, one of them later went to fists, the other two stayed on fists; V drew a gun (`the brawl escalates: 1 of 1 draw their own weapons`) and nothing changed | (a) one targeting search at 1.2 s, for people already in combat and hostile: the gang joined later, and the targeting system lists what V can target, not the brawler's gang; (b) the friends were never found, so nobody put their guns away; (c) the game's weapon switch command (`AISwitchToPrimaryWeaponCommand`) was accepted and did nothing: the fists we equipped stayed | (a) the friends are searched three times (at 1.2 s, 3 s and 6 s), from the brawler's own **squad** (`AISquadHelper.GetSquadmatesID`, in combat or hostile) and the targeting search (hostile), within 20 m of V; (b) each new friend's drawn weapon is remembered, put away, and fists asked; (c) the escalation **equips the gun** the same way the fists were equipped (`AIEquipCommand` into the right hand): the weapon that person was seen holding, else the first ranged weapon it carries, else the switch command; 1.5 s later every brawler's hand is read back by person, and anyone still on fists is asked once more |

## Live test 3 (game 2.31, 2026-10-27, switch OFF) and what changed

| Seen live | Cause | Fix (`fix/threats-decide`) |
|---|---|---|
| No reaction fired at all (Local AI text + Pocket voice): `probe.log` `NPC reaction offered: kinds=leave,call-police type=street-resident message=1`, then `NPC reaction offer ended before it was used: menu`; `bridge.stderr.log` `[NPCReaction] NPC reaction: person=npc-street-resident-male offered=leave,call-police admitted=yes route=text tag=none(no-tag) delivered=-`, the same for the homeless, a joytoy (`offered=leave,attack`), a nightlife resident and three Tyger Claws (`offered=leave,attack`), for "get lost or I'll kill you" and insults and dares to the gangers | the switch was **off** in the 2.31 install (`runtime/settings.json` `"npcThreats":false`): the offer line has no `threats=on ... plan=`. Only a threats offer carried the game's plan, so the old path ran, where only the model's tag starts a reaction, and the model never tags. The screen did read "get lost or I'll kill you" as `kill`; it missed most of the insults and dares ("you're weak", "your gang is trash", "Tyger Claws are scum", "pussy", "you don't scare me", "try me", "bring it on") and "move or I'll shoot" | **the game decides on both sides of the switch**: every offer carries the person's plan (switch off: of the old kinds only, leave, call the police, attack), and the screen's reading picks the reaction on every provider with no tag. The screen reads the insults, gang insults, dares, robbery and "or I'll shoot" (below). The turn's line now says what the game made of the words: ` game=<kind>` or ` game=none(<why>)` |

With the switch **off** the plan uses only the old kinds: a civilian answers a death threat, a threat or an insult by leaving or calling the police
(its row's first allowed kind: cower is not one); a ganger or soldier answers a death threat and a threat to hurt (and a dare) with **attack** (the
weapon: fists are a switch-on kind) and an insult by **leaving**; a clerk calls the police; nomads leave. Commands do nothing with the switch off.
With the switch **on**, as before: fists for an insult or a dare, the weapon for a death threat, cower, the commands.

## Live test 2 (game 2.5, 2026-10-27, switch on) and what changed

| Seen live | Cause | Fix (`fix/threats-crowd`) |
|---|---|---|
| Gangers: a death threat draws and attacks (05:49:43Z `attack ok`); an insult brings fists and his friends join with fists (05:53 `brawl hand=fists`) | works | kept |
| One friend fought with a gun from the start; the owner's new rule: when V draws or uses a gun the brawlers switch to their guns (escalate when V escalates, never de-escalate on their own) | the friends were never asked for fists; nothing watched V's weapon | "A brawl and its friends" below |
| Walking pedestrians: a threat or "Get down on the ground!" and the person walks on (and says it won't), while the people around start running (the owner likes that): `get-down started, the crowd's own fear (the crowd reaction event, no move command)`, then `get-down crowd moved=1.5 m in 3 s` / `2.8 m in 3 s` (05:51:34Z, 05:52:13Z). With the switch off a threatened walking pedestrian also walked on | the reaction let go of the conversation first (`release`), and only then sent the crowd's fear. The conversation's focus is what had stopped the person: `ConvaiBeginFocus` sends it an `AIHoldPositionCommand` (`r6/scripts/CyberpunkConvai/Engagement.reds:91-96`, logged by `mod/init.lua:2634-2638` "Crowd focus begin: crowd focus started"), which takes a walking crowd person out of the crowd's traffic while the command runs. Let go of it and the traffic has the person back at once; the fear event reached it (its fright spread to the people around) but its walk was the traffic's | the same mechanism, kept without a gap: the person gets **its own command while the conversation's hold still runs**, and only then is the conversation let go ("Walking crowd people" below) |

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

Since `fix/threats-crowd` the fear-only path above is for **seated** crowd people (a workspot: a bench, a counter, a wall; also a workspot that
cannot be read). Shandor's three were all seated (`workspot=true`), and the conversation's focus never holds a seated person.

### Walking crowd people (live test 2, `fix/threats-crowd`)

The mechanism reused is the one that already stops a walking crowd person when V talks to it: `PlayerPuppet.ConvaiBeginFocus`
(`r6/scripts/CyberpunkConvai/Engagement.reds:82-125`) sends a crowd or civilian person who is not in a workspot an `AIHoldPositionCommand`
(40 s, lines 91-96) through its AI component. While an AI command runs, the crowd's traffic does not move the person; `ConvaiEndFocus`
(lines 53-77, called by `endFocus` in `mod/init.lua`, which is the reaction's `release`) stops that command, and the traffic has the person back.
The first two builds let go first and acted after, so the person walked on. Now, for a walking crowd person (`npc:IsCrowd()` and not in a
workspot), the reaction sends **its own command first**, while the conversation's hold still runs, and lets go only after that:

| Kind | Order | The person | Back to the crowd |
|---|---|---|---|
| leave (and the run after a police call, and the switch-off leave) | the crowd reaction event (phase 3: the game's own fright for the people around, its fear face and voice), the first run leg, then the conversation lets go | runs away in **legs**: a first leg of 4 m, read back after 0.4 s; then legs of 8 m, each sent from where the person is a second later, before the last one ends (no stop, no start animation between legs: `useStart` off), up to the walkable point 30 m away or ten legs | when it arrives (`ran <m> m in <n> leg(s); back to the crowd`), or once it streams out of sight |
| cower, get-down | an `AIHoldPositionCommand` (20 s), the scared pose (no crowd fear since live test 4: it walked the person off), then the conversation lets go; a hold not running at 1.2 s is sent again for the rest | holds still where it is, in the scared pose | when the hold ends (`hold over, back to the crowd`, the pose off) |
| stop | an `AIHoldPositionCommand` (30 s) without letting go (as before: the talk goes on) | holds still | when the hold ends |

**Never a teleport, at worst one leg.** The game puts a crowd person given a move command at its end point at once in the cases seen so far
(Shandor's seated people). Every leg is read back: a leg covered faster than anyone runs (7 m a second, at least 3 m) was a jump, and the person gets
no further move, only the crowd's fear stage (`leg <n> moved=<m> m in <s> s (jumped, not run); no more moves, the crowd's fear instead`). The first
leg is 4 m, so the worst a jump can do is 4 m. A person that does not move in two read-backs gets the fear stage too (`did not run`).

## A brawl and its friends (live test 2, `fix/threats-crowd`)

- **Friends.** Searched at the brawl's first read-back (1.2 s) and again 3 s and 6 s after it began (live test 4: the gang joins over a few
  seconds), within 20 m of V, from two places (`natives.joined`): the brawler's own squad (`AISquadHelper.GetSquadmatesID`; a squadmate in
  combat or hostile to V) and the game's targeting search (hostile to V). Up to four of them, each an ordinary person by the same rails as the
  brawler (never a companion, another mod's character, a story or quest character, a child), get the same fists (a drawn weapon remembered, then
  put away): `brawl joined by <n> more (search <i> of 3: squad <a>, nearby <b>), asked for fists (<k> had a weapon out, asked to put it away)`.
  One who joins after the escalation draws instead: `..., asked to draw (V has a gun out)`.
- **Escalation, the owner's rule.** While a brawl lasts (up to 120 s) V's right hand is read once a second (`natives.vArmed`: a ranged weapon's
  record, else false). The moment V holds a gun, every brawler (the person and its friends) is given its gun with the same equip command that
  gave it its fists (`AIEquipCommand` into `AttachmentSlots.WeaponRight`): the weapon it was seen holding before it was put away, else the first
  ranged weapon it carries (`TransactionSystem.GetItemList`), else the game's `AISwitchToPrimaryWeaponCommand` (live test 4: that command alone
  changed nothing). `V drew <record>; the brawl escalates: <n> of <m> draw their own weapons (equip <record>; equip <record> (carried); ...)`, then
  1.5 s later `brawl escalated, <k> of <m> hold a weapon (<hand>, <hand>, ...)`; a hand still on fists is asked once more and read back once
  more. Once, for good: nothing is put away after it, V putting the gun away does not take them back to fists, and the watch stops. A brawl that
  starts with V already holding a gun escalates at the first watch, before anything is put away. A death threat is still the plain `attack` with
  weapons from the start.

## Who decides: the game (the owner's rule of 2026-10-26)

In live test 1 the model never chose a reaction on any provider. The rule since then: **when the screen reads V's words as a death threat, a threat
to hurt, an insult or one of the three commands, and the person's kind allows a reaction for it, the GAME picks the reaction** from the person's
kind and temper, and the model is only told what the person does so that its line fits ("you attack V with your fists"). The model's own choice (the
tag, the Convai action) is left only for words the screen does not read.

- **The plan** (`mod/npc-reactions.lua` `M.plan`): each offer carries the game's pick for every reading at once, `plan = {kill,
  hurt, insult, get-down, stop, exit-vehicle}` -> one allowed kind. Since live test 3 on both sides of the switch: with the switch off the plan
  has only the old kinds (leave, call the police, attack) and no commands, and the person's temper is read for it too. It is made at the offer because the words are often heard only later (a voice
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
- The turn's line says who chose: `... tag=attack delivered=yes screen=kill game=attack by=game` (or `by=model`), and, when the game chose
  nothing, why: `game=none(unread)` (no threat, insult or command read), `none(joke|quote|question|negated)`, `none(no-row)` (a reading this
  person's plan has nothing for: a command with the switch off), `none(unheard)` (a voice turn whose words were never read).

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

### The feeling of a decided reaction (live test 4)

The model's note for a decided reaction (`decidedReactionText(kind, reading)` in `bridge/companion-actions.mjs`; the text routes' `GAME
REACTION:` note and the Convai context) is short plain sentences: what V just did (from the reading that picked the reaction), what the person
feels, what it does, how the line sounds, and, for the frightened ones, "Do not sound calm or brave, and never say V does not scare you."; for a
fight, "Do not back down or apologise.". The reading travels with the decided config (`reaction.reading`) and the text host's own decision.

| Kind | After a threat or a command | After an insult |
|---|---|---|
| leave | scared of V: backs away and gets out fast; frightened, shaky, pleading or panicked | offended and fed up: turns its back and walks away; cold and offended |
| call-police | scared of V: calls the police right now; frightened and urgent | angry at V: calls the police; angry and fed up |
| cower | terrified: freezes, crouches, covers its head; begging and stammering | (never offered for an insult) |
| get-down / stop / exit-vehicle | scared of V: does as V said (and stays down); frightened and obedient / nervous and careful | |
| brawl | angry at V: fists up and fights; furious and ready to fight | the same |
| attack | deadly serious: pulls its weapon and attacks; cold and dangerous | |

A Convai voice turn (the words not heard yet) gets the plan with the same feelings: "if it threatens to kill you, you are deadly serious: you
pull your weapon and attack V (you sound cold and dangerous); ...".

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

### Insults, dares and conditions (live test 3, 2026-10-27; English)

- **Death threat with no object**, after "or / before / else / otherwise": "move or I'll shoot", "back off before I blast", "or else I'm gonna waste
  you" (not "or I'll shoot it / the target").
- **Insult**: "you're weak / nothing / soft / spineless / gutless / trash / garbage / a nobody / a disgrace / chicken" (not "you're nothing like
  him", "soft spoken", "nothing special"); "you're a bunch of losers / pussies", "you little wimp"; a gang as a whole: "your gang / crew / boys is /
  are trash, nothing but cowards", "Tyger Claws / Maelstrom / Valentinos / ... are scum / trash / pussies", "fuck the Tyger Claws"; one word as a
  whole sentence: "Pussy!", "Coward.", "Wimp".
- **Threat to hurt (a dare or a robbery)**: "you don't scare me", "I'm not scared of you", "bring it on", "bring it!" and "try me" / "make me" as a
  whole sentence (not "bring it here", "make me a sandwich"), "I dare you", "come and get it", "what are you gonna do about it" (without a
  question mark), "hand over / give me / gimme your eddies / money / cash / wallet".

Without a plan the words only **narrow the offer** (`screenedKinds`); they never start anything:

| Kind | Needs in V's words |
|---|---|
| `leave`, `call-police` | nothing new: the model's choice alone, as before this feature |
| `attack` (with a weapon) | a death threat |
| `brawl` (with fists) | a threat to hurt, a fight challenge or an insult |
| `cower` | a death threat or a threat to hurt (nobody cowers at an insult) |
| `get-down`, `stop`, `exit-vehicle` | that command |

So a cop on a calm line is offered nothing at all (the turn's line says `admitted=no(screened)`), and a model that writes `[attack]` anyway hands
nothing over. With the switch on, `attack` also needs the death threat: the model alone never starts a fight. With the switch off the offer is
never narrowed (the model keeps the old kinds for words the game does not decide), but the game's plan reads the words as above.

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
| leave, walking crowd person | the crowd event (phase 3), then `AIMoveToCommand` legs (`Run`, 4 m then 8 m, later legs `useStart` off), sent before the conversation lets go; a jump or a stall: the fear stage | (not crowd) | **unconfirmed** (live test 3) |
| cower, get-down, walking crowd person | `AIHoldPositionCommand` 20 s first, the scared pose (`fear` animation set on, off when the hold ends), then the conversation lets go; no crowd fear (live test 4: its Surrender lasted a second, then the crowd walked him 39 m); the hold sent again if not running | (not crowd: the same hold and pose) | **unconfirmed** (live test 5) |
| brawl friends, escalation | the squad (`AISquadHelper.GetSquadmatesID`, `Game.FindEntityByID`) and the targeting search (`GetTargetParts`), three times; the same fists and put-away; V's gun (`ScriptedPuppet.GetWeaponRight(V)`, `WeaponObject.IsRanged`) read once a second, then `AIEquipCommand` of each brawler's own gun (seen, else carried: `TransactionSystem.GetItemList`), else `AISwitchToPrimaryWeaponCommand`; hands read back 1.5 s later | same | **unconfirmed** (live test 5) |
| leave, seated crowd person | `DelayedCrowdReactionEvent` (phase 3), `StimuliEvent.new()` (or `NewObject('senseStimuliEvent')`) from V of type `Terror` with its record (`StimuliSystem.GetStimRecord`), `npc:QueueEvent`; else, or when it did not move the person, the crowd's fear stage (`ChangeFearStage(Panic)` and the calls above) | `AIMoveToCommand`, as before | crowd: **unconfirmed** (live test 1 crashed on `NewObject('StimuliEvent')`, fixed); walk: live |
| cower, get-down, seated | the same event, phase 2 (the seat's own fear); else the fear stage `Alarmed` | `AIHoldPositionCommand` 20 s and the scared pose | **unconfirmed** / live |
| brawl | hostile + combat start as `attack`, then `AIEquipCommand` of `Items.w_melee_004__fists_a` to `AttachmentSlots.WeaponRight` (`failIfItemNotFound` off: nothing is added to the inventory); after 1.2 s, if the hand holds a weapon, one `AIUnequipCommand` | same | combat: live; fists: **unconfirmed** |
| attack | unchanged (a weapon) | same | live |
| stop | `AIHoldPositionCommand` 30 s, **without** letting go of the conversation (the talk goes on; the hold outlasts the conversation's own) | same | live (the conversation hold is the same command) |
| exit-vehicle | `AIEvent` named `ExitVehicle` queued on the person: the passenger exit the game itself queues (`vehicles.script` `TriggerExitBehavior`) | same | **script** |

Read-backs, one each: `crowd moved=<m> m in 3 s`, `hold state=<s>` (and `hold was <s>, sent again for <n> s`), `brawl in_combat=... hostile_to_v=... hand=<fists|empty|record>`,
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
- `NPC reaction offered: kinds=... type=<base> message=<n> threats=on temper=<aggressive|passive|neutral|?> plan=<reading:kind,...|->` (` threats=on`
  only with the switch on; `temper=` and `plan=` always since live test 3)
- `NPC reaction: leave started, the crowd's own flight (the crowd reaction event, no move command)` or `(the fear stage, no move command)`,
  `... cower started, the crowd's own fear (...)`, `... get-down started, holds still for 20 s (...)`, `... stop started, holds still for 30 s`,
  `... brawl hostile ok, combat start ..., fists fists asked`, `... exit-vehicle started, the game's own exit`
- a walking crowd person: `leave started, taken from the crowd and run away in legs (<m> m from V; ...)`, `first leg moved=<m> m in <s> s
  (running)`, `ran <m> m in <n> leg(s); back to the crowd`, or `leg <n> moved=<m> m in <s> s (jumped, not run); no more moves, ...`, `did not
  run (...)`, `run over after <n> leg(s): the person streamed out`; `get-down started, holds still for 20 s, taken from the crowd before the
  conversation let go, in the crowd's own fear`, `get-down hold state=<s> moved=<m> m`, `get-down hold over, back to the crowd (moved=<m> m ...)`
- a brawl: `brawl joined by <n> more, asked for fists (<k> had a weapon out, asked to put it away)`, `V drew <record>; the brawl escalates: <n>
  of <m> draw their own weapons`
- the read-backs above; `NPC reaction: leave did not move; asked again with the fear stage (sent)`; `NPC reaction: fear failed: ...` /
  `panic failed: ...` (once each); `neither the crowd's reaction event nor its fear stage is available for leave; the person stays`

`bridge.stderr.log` (`[NPCReaction]`): the turn's one line gains ` screen=<code>` (every offer with a plan): `kill`, `hurt`, `insult`, `get-down`, `stop`,
`exit-vehicle`, `insult+stop`, `none`, `none(joke|quote|question|negated)`, `unheard` (a voice turn: the words are read later; a text route's
spoken turn gets the transcript's reading once the text host has it). Then ` game=<kind>` or ` game=none(<why>)`, the game's verdict ("Who
decides"). Codes only, never V's words. `offered=` is then what this turn may hand over; `admitted=no(screened)` means nothing. A chosen kind ends
with ` by=game` (the plan) or ` by=model` (a tag, a Convai action). A Convai voice turn the page decided keeps `screen=unheard` (the page sends the
pick, not the reading) and shows the pick in `game=`.

## Files

| File | Role |
|---|---|
| `bridge/threat-screen.mjs` (new) | the screen of V's words, 16 languages, lethal phrasings, question tags; `screenedKinds` |
| `mod/npc-reactions.lua` | kinds per person with the switch, the game's plan (`M.plan`, `M.TEMPERS`, `M.seed`), the rails (vehicle, command cooldown, brawl), the natives (crowd fear event, crowd fear stage, hold, fists, holster, hand, exit, mount reads, workspot, V's gun, weapon switch, the brawl's friends, the snapped leg), the crowd flight fix, the walking crowd person taken from the crowd first and run in legs, the brawl's friends and escalation, the read-backs |
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

Added 2026-10-27 (`fix/threats-crowd`), `bridge/npc-threats-lua.test.mjs` (25): the fake now moves a person along a walk at a given speed on the
test clock (or puts it there at once, as the game does to a crowd person) and records the order of what the person was sent:
- a walking crowd person's leave: the event, the first leg, THEN the conversation lets go; legs read back one by one, later legs without a start
  animation, back to the crowd on arrival, nothing more after it; a jump stops after that one leg with the fear stage; a person standing still
  twice gets the fear stage; a seated person (or an unreadable workspot) never gets a move command; anyone not in the crowd walks as before;
- cower and get down for a walking crowd person: the hold, the fear (phase 2, or the fear stage), THEN the release; held in place; back to the crowd
  when the hold ends; seated: the seat's own fear, no hold; not crowd: a hold; both fears switched off: a hold;
- a brawl's friends get fists and their guns put away (a story character among them is left alone); V's gun makes every brawler draw once and for
  good, V holstering does not undo it, the watch ends by itself; a brawl started with V's gun out escalates before anything is put away;
- the natives: the workspot read, V's gun (a blade is no gun), the weapon switch command, the friends' search (only fighting and hostile, never the
  brawler, no doubles), the snapped leg point, a continuing leg without `useStart`.

Added 2026-10-27 (`fix/threats-decide`), from the live test 3 log lines and phrases:
- `bridge/threat-screen.test.mjs` (+1, 29): "get lost or I'll kill you" and the object-less conditions as death threats; the insults, gang insults,
  one-word insults, dares and robbery; what only looks like them ("you're nothing like him", "bring it here", "make me a sandwich", "or I'll shoot it").
- `bridge/npc-threats-lua.test.mjs` (25, two rewritten): the switch-off offer carries a plan of the old kinds and reads the temper once; the offer
  line `kinds=leave,call-police type=street-resident ... temper=neutral plan=kill:...`; a Tyger Claw's `plan=kill:attack,hurt:attack,insult:leave`;
  the joytoy, the homeless and a nightlife resident each get a plan.
- `bridge/npc-threats-decide.test.mjs` (+3, 11): a plan without the threats flag is kept for the old kinds only; a Tyger Claw on a typed Local AI
  turn with the switch off (death threat, two dares, two insults: decided, handed over, one line with `screen=` `game=` `by=game`, no tag); the same
  with the switch on (fists for an insult or a dare, the weapon for a death threat or "move or I'll shoot"); the text menu's `game=` verdict for
  unread words, a joke, a command with no row; the Convai window opening and deciding on a switch-off plan.
- `bridge/npc-reaction-pipeline.test.mjs` (8, six rewritten, one new): through the real Lua offer and lease with the switch off: typed Local AI
  "get lost or I'll kill you" decided at admission with no tag (`route=text tag=leave delivered=yes screen=kill game=leave by=game`); the spoken
  turn decided by the text host from the transcript; a Convai typed turn decided at admission, the model's own Call Police not taken; unread words
  leaving the model its kinds (`game=none(unread)`); the refusal lines with `screen=`.

Added 2026-10-27 (`fix/threats-live4`), from the live test 4 log lines:
- `bridge/npc-threats-lua.test.mjs` (25, five rewritten): get down for a walking crowd person: hold, scared pose, release, no crowd fear, the
  pose off when the hold ends; a hold still `Enqueued` sent again once for the rest of the 20 s; a failing pose is no failure of the hold; a brawl
  whose friends come after the first search (found at search 2, nobody twice, the story character left alone); the escalation equips each one's
  remembered gun or what it carries, and reads every hand back; a draw the game ignores is asked once more and read back once more; a friend
  after the escalation draws; the natives: the equip by record, the carried gun (a blade skipped), the switch command as the last way, the pose on
  and off, the squad lookup with the targeting search (fighting or hostile squadmates near V, hostile others only, never the brawler).
- `bridge/npc-threats-decide.test.mjs` (+1, 12): the feeling note per kind and reading (the live corpo case word for word), the reading carried
  in the decided config to the text menu and the Convai window, a spoken turn's transcript picking the insult feeling.
- `bridge/npc-reaction-pipeline.test.mjs` (8): the decided configs carry the reading; the frightened note reaches the Local AI prompt; "get down"
  through every real piece is held in the scared pose with no crowd fear.

## Live test (owner)

Live tests 1 to 4 (2026-10-26 and 27) found the problems at the top. Live test 5 is this one, for `fix/threats-live4`.

Install: overlay the committed files of the branch: `mod/npc-reactions.lua` (never `mod/diagnostics.lua`), `bridge/companion-actions.mjs` and
`bridge/text-actions.mjs`, then CET reload and a bridge restart (no redscript, no game restart). Use a throwaway copy of a save. Keep
`probe.log` and `bridge.stderr.log` open.

1. **Switch off, Local AI "lite", a walking pedestrian, "get lost or I'll kill you".** `[NPCReaction] ... tag=leave delivered=yes screen=kill
   game=leave by=game`, the run as in live test 4. **Does the person's line sound frightened (pleading, panicked), never "you don't scare me"?**
   Then an insult ("you stupid bitch") to another pedestrian whose plan says `insult:leave`: **offended and walking off, not scared?**
2. **Switch on, "get down on the ground!" to a walking pedestrian.** `get-down started, holds still for 20 s, taken from the crowd before the
   conversation let go, in the scared pose (no crowd fear)`, then `get-down hold state=Executing moved=<under 1> m` (or `hold was Enqueued, sent
   again for 19 s (sent)` and a second `hold state=Executing`), and 20 s later `get-down hold over, back to the crowd (moved=<under 1> m in the
   hold, scared pose off)`. **Does the person stay where it is the whole 20 s, in a scared pose, then walk on?** Its line: frightened and obedient.
3. **The same with a death threat to a pedestrian whose plan says `kill:cower`.** The same hold and pose; the line terrified.
4. **A ganger with friends around, an insult** (Northside, not in a safe zone). `brawl ... fists fists asked`, then `brawl joined by <n> more
   (search <i> of 3: squad <a>, nearby <b>), asked for fists (<k> had a weapon out, asked to put it away)` (three `search` lines in the first 6 s).
   **Do all his friends fight with fists, guns put away?**
5. **Escalation.** In that brawl, draw a pistol: `V drew <record>; the brawl escalates: <n> of <m> draw their own weapons (equip <record>; ...)`,
   then `brawl escalated, <k> of <m> hold a weapon (<records>)`. **Do all of them switch to guns?** Holster yours: **they keep their guns.** Note
   any `fists -> asked again (...)` in the read-back.
6. **A friend who arrives after you drew**: `brawl joined by 1 more (search 3 of 3: ...), asked to draw (V has a gun out)`.
7. **Frame rate.** Talk to a few people and start one brawl; FPS as before (one read a second during a brawl, three friend searches, nothing else).

What only this can confirm: that a held crowd person stays without the crowd's fear, that the `fear` animation set gives it a scared pose while
it stands, that the squad lookup finds a gang's members from CET, and that equipping the gun by its record puts it in the hand mid-fight.

## Open risks

- Live test 4: a held crowd person no longer gets the crowd's fear (it walked him off); whether the `fear` animation set alone gives a visible
  scared pose while it stands is what live test 5 shows (the hold keeps it in place either way). The squad lookup
  (`AISquadHelper.GetSquadmatesID`, an out list from CET) and the gun equip by record are new from CET; each is guarded, and the targeting search
  and the switch command stay as the fallbacks.
- The crowd event, the fists command and the exit event are called from CET for the first time. Each is guarded and logged; a missing one loses
  only that outcome (a crowd person then gets the fear stage instead, and stays only when that fails too; a brawl is a plain fight, a get-out does
  nothing). Live test 2 showed the crowd event and the fear stage alone do not move a WALKING crowd person (its traffic has it): such a person
  now gets its own command first. Whether that command walks it for real or puts it at the end point is what live test 3 shows; a jump is caught
  after one leg (at most 4 m for the first).
- A brawl's escalation reads V's hand once a second for at most two minutes; the weapon switch command and the friends' search are new from CET.
- The game shares a crowd person's fright with bystanders within about 10 m (its own `SpreadFear` when the source is V). A "get down" in a busy
  street may scatter the people around; that is the game's own behaviour when V threatens someone.
- The words screen now decides: a false match (a line it reads as a threat that is not one) makes the person react as its plan says. It is
  tuned against the lines that only sound violent (tests); a rare lethal phrasing it misses leaves the model its old choice.
- A Convai voice reply is written by Convai as soon as it hears V, from the plan in its context; if it ignores it, the game still does what the
  plan says (the line may then not fit).
- The game decides from the reading, not from the reply: a person whose reply refuses still reacts (the decided note tells the model not to refuse).
