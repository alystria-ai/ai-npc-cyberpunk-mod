# Consequences of talking to ordinary NPCs

Written 2026-10-21 on branch `feat/npc-reactions` (from `main` fc2b8c82). Unit-tested; not merged, not pushed, not installed, **not seen in the game**.

## The decision

A player asked for "pedestrian NPCs becoming hostile depending on how a conversation goes". The owner approved it on 2026-10-21 as a narrow exception to the rule that the mod never touches a character the game placed (docs/WORLD_COMPANIONS.md): an **ordinary, game-placed NPC** (not a story or quest character, not our companion) can, because of what V said to it, do one of three things, once:

| Outcome | What the NPC does | Who gets it |
|---|---|---|
| `leave` | ends the talk and walks (or, a civilian, runs) away | civilians, gangers and mercs, nomads, corporate staff |
| `call-police` | reports V: the game's own wanted stage goes up by one (the lowest step). A civilian also runs; a clerk or a guard stays at its post | civilians, clerks and vendors, corporate security, corporate staff |
| `attack` | turns hostile to V and the game's combat AI takes over | gangers, mercs, goons, soldiers, corporate security, cops |

Nothing else about an ordinary NPC changes. Companions (our spawned copies) are untouched: they have their own actions (`bridge/companion-actions.mjs`) and never receive this offer.

## Who is offered what

`mod/npc-reactions.lua`, `M.BY_CATEGORY` and `M.BY_BASE` (from the archetype the adapter already sends with every ordinary NPC turn: `category` and `base`, `docs/NPC_ARCHETYPES.md`):

| Kind of person | Offered |
|---|---|
| Residents (corporate worker, street local, nomad, person living rough, club-goer, city worker, Dogtown resident, the generic resident) | leave, call-police |
| Gangs (Maelstrom, Tyger Claws, Valentinos, 6th Street, Animals, Voodoo Boys, Scavengers, Wraiths, Mox, Barghest), factions (Militech, Kang Tao, NetWatch, mercenary, street goon) | leave, attack |
| Aldecaldos nomads | leave |
| Biotechnica staff, Trauma Team | leave, call-police |
| Corporate security | call-police, attack |
| NCPD | attack (a cop never leaves, and never calmly: a threatened cop turns on V) |
| Vendors (ripperdoc, weapons, food, bartender, clothing, medic, junk, melee, netrunner, market stall) | call-police only |

Why vendors only report: the scope excludes "vendors or fixers the player needs", while the feature also wants a "vendor-type in a public place" to report V. The reading that satisfies both: a vendor can call the police (the wanted stage rises) but never walks off its post and never turns hostile, so no shop is ever abandoned, locked or made unusable. Fixers are named characters and are never touched.

A cop is offered only `attack`. The game has no arrest we can call, and a cop that walks away from a threat is not believable. Attacking is the "arrest or attack" decision, made for the cop.

## How the decision works

The **NPC's reply decides**, so it stays in character. The game side offers only what the game allows (the offer is one more lease on the request, like the companion offers); the model may use one of the offered kinds, and only when V's words clearly earned it.

| Provider | The model signals it | The bridge hands it over |
|---|---|---|
| Mistral, Local AI, Custom | one tag at the very end of the reply: `[leave]`, `[call-police]` or `[attack]` | `TextProviderHost` cuts the tag from the text (the voice, the subtitle and the memory never see it) and delivers `{version, token, reaction}` through `CompanionActions.deliver` |
| Convai | Convai's own action list: `Walk Away <token>`, `Call Police <token>`, `Attack V <token>` (only the offered ones), requested in the same reply | `CompanionActionWindow.accept` -> the same `deliver` |

There is **no decision request** (unlike the companion actions, which first ask a tiny classifier): the reply is written once, with one more sentence in its notes. That sentence is for ordinary NPCs only, lists only the offered kinds, and costs about 100 tokens:

> GAME REACTION (rare): only when V clearly threatens you or seriously insults you and you truly would react, end your reply with one tag after your words: [leave] you end the talk and walk or run off; [call-police] you report V to the police. No tag for normal, rude-but-harmless or joking talk, nor when your own reply stays calm; never at the start. Never speak of tags.

The Convai sentence says the same about the action names, and ends with "almost every reply has no action".

Why a tag and not a classifier here: the companion actions measured badly with a code that opens the reply on every turn (the persona picked the code by mood, `docs/MISTRAL.md`). Here the tag is rare, comes last, and only counts when it is the last thing in a reply that has words before it. A tag anywhere else, two tags, a tag for a kind that was not offered, or a reply that was cut back to its first sentence does nothing; the bridge logs `NPC reaction tag in the reply was not used (<why>)` with the reason only, never the words.

### The tag in the text

- Cut from every text: `splitActions` (`bridge/text-actions.mjs`) removes `[leave]`, `[call-police]` (also `[call police]`, `[call_police]`, `[police]`) and `[attack]`, with its own full stop, in the streamed view too (an unfinished `[call-po` is held back from the voice and the subtitle). Sounds and feelings (`[laughter]`, `{anger}`) are not touched.
- Counts only: last in the reply, once, with words before it, for an offered kind (`reactionMenu(...).pick`).
- The reply is never remembered with the tag.

### "Never on the first line"

Read as the first message V sends a person: it earns no offer at all (`minExchanges = 1` in `mod/npc-reactions.lua`). The offer exists from V's second message to the same person (a conversation older than ten minutes starts again). The instruction also says "never at the start" of the reply. If the owner meant only the reply's first sentence, set `minExchanges = 0`; nothing else changes.

## The rails

All in `M.allowed` (pure, tested), asked when V's message is admitted (the offer), again when the bridge hands the reaction back, and again when it starts:

| Rail | Rule |
|---|---|
| Who | `convaiWorldPolicy`: not ours, not another mod's, not protected (named, quest or story record), not a story character; the person's quest flag (`MainQuest`, `SideQuest`, `MinorQuest`) must read as not set (a vendor flagged as a quest actor gets nothing either); never a child |
| When | the game is not in charge: the world-talk guard (`mod/world-talk.lua`: a quest dialogue, a call, a scene of V's own at tier 3 or above, the person in a scene dialogue or under a scene's AI, a fight of the person or of V, an injury, a vehicle). This covers quests, scenes and braindances as far as the game reports them as V's scene tier |
| First line | V's first message to a person never earns an offer |
| Once | at most one reaction per person (until the save is reloaded) |
| Cooldown | after an `attack` or a `call-police`, none of those two for 120 s for anyone; `leave` is not counted |
| Safe zones | no `attack` and no `call-police` where combat is disabled: `PlayerStateMachine.Zones == Safe`, V inside a `SafeAreaManager` volume, or a `NoCombat` status on V. A zone that cannot be read refuses the hostile kinds |
| Police | only while V is not wanted (heat stage 0) and only when the game's own `PreventionSystem` says it would react (`CanPreventionReact` and `ShouldReactionBeAgressive`, the latter false in security areas). Already wanted: the call is not offered, there is nothing lower to do |
| Attack | only on a person who is not hostile to V already |
| Native failures | every call guarded with `pcall`, one log line per failure kind (`convaiLogOnce`), switched off for the session after 3 failures (`attack`, `call`, `walk`, and each read) |

An unreadable fact refuses what depends on it (fail closed); talking is never affected.

## What the game does (native calls)

Nothing runs per frame. The offer is made once when V's message is admitted (a few reads); the reaction starts once, after the NPC has finished speaking (`update()` is one nil check while nothing waits: the reply is awaited, then speaking, then 1.5 s of quiet, or 120 s at most), and one read-back is logged 1.2 s later. Before it starts the conversation's hold and look-at are let go (`endFocus`, the same release a conversation end uses).

Status key: **live** = a call this mod already makes in the game, seen working; **script** = exists with this exact signature in the game's script dump (`tools/redmod/scripts`, read 2026-10-21) but is not yet called by this mod, so unconfirmed from CET; **log** = what the read-back line will say.

| Step | Call | Status |
|---|---|---|
| Walk away: ground | `Game.GetAINavigationSystem():FindPointInSphereForCharacter(point, 3, npc)`, status `worldNavigationRequestStatus.OK`; three points directly away from V (30 m, then 35 degrees to either side, then 14 m), each at least 10 m from V and farther than the person stands | live (companion actuator, adoption) |
| Walk away: move | `NewObject('AIMoveToCommand')` with `movementTarget` (`AIPositionSpec` of a `WorldPosition`), `movementType` Walk or Run (residents run), `finishWhenDestinationReached`, `useStart`; `npc:GetAIControllerComponent():SendCommand(command)` | live (companion actuator); on a crowd NPC unconfirmed, but the same controller already takes `AIHoldPositionCommand` for the conversation hold (`Engagement.reds`) |
| Walk away: read-back | `GetCommandState(command)`; a failed command is tried once at the next point | live |
| Police | `PreventionSystem.CrimeWitnessRequestToPreventionSystem(player:GetGame(), player:GetWorldPosition())`: the request the game's own `CallPolice` AI task sends when a pedestrian reports a crime (`aiStimReactionTask.script`); `PreventionSystem` then runs `HeatPipeline("CrimeWitness")`: stage +1 when V is not chased yet | **script** |
| Police: gates | `PreventionSystem.CanPreventionReact(game)`, `PreventionSystem.ShouldReactionBeAgressive(game)` (public static) | **script** |
| Police: read-back | `GetHeatStageAsInt` (else `GetHeatStage`) on the prevention system | read once a turn by `mod/turn-context.lua` since 2026-10-14, itself not yet confirmed |
| Attack: hostile | `npc:GetAttitudeAgent():SetAttitudeTowards(player:GetAttitudeAgent(), EAIAttitude.AIA_Hostile)` and read back | live (companion tactic, target side) |
| Attack: combat | `npc:GetStimReactionComponent():TriggerCombat(player)` (private script function, called by name), else `AIActionHelper.TryStartCombatWithTarget(npc, player)` | live (companion tactic) |
| Attack: second ask | after 1.2 s, if the person is hostile but `NPCPuppet.IsInCombat` is false: `TriggerCombat` again and `NPCPuppet.ChangeHighLevelState(npc, Combat)`, once | live (companion tactic, `setHighLevel`) |
| Safe zone | `player:GetPlayerStateMachineBlackboard():GetInt(Game.GetAllBlackboardDefs().PlayerStateMachine.Zones) == gamePSMZones.Safe`; `Game.GetSafeAreaManager():IsPointInSafeArea(position)`; `StatusEffectSystem.ObjectHasStatusEffectWithTag(player, 'NoCombat')` (the three signals `ReactionManagerComponent` itself reads) | **script** (the blackboard read is the pattern `mod/companion-seating.lua` uses) |
| Facts | `IsCharacterChildren`, `IsDeadNoStatPool`, `IsAttached`, `ScriptedPuppet.IsDefeated`, `NPCPuppet.IsInCombat`, the world-talk reads | live |

If `CrimeWitnessRequestToPreventionSystem` is missing or fails (three times), `call-police` is switched off: it is no longer offered, and the bridge's instruction for that turn no longer lists it. If a police call becomes impossible between the reply and its start (V got wanted meanwhile), a civilian still runs, which is the honest part of the line it just said; a clerk does nothing.

Not used, and why: the game's own reaction outputs (`gamedataOutput.WalkAway`, `Flee`, `CallPolice` through `ReactionManagerComponent.TriggerReactionBehaviorForCrowd`, a private overloaded function) would give the full vanilla animations, but an overloaded private call is a guess from CET and only works for crowd AI. `AIMoveToCommand` is the call this mod already knows works. If the live test shows crowd NPCs ignore the walk command, the reaction call is the next thing to try.

## Setting

None. The project prefers no toggles, the feature is rare and bounded, and it never touches a story character. A player who never wants police heat or a hostile pedestrian simply does not threaten pedestrians. If that proves wrong, one row next to "Talk to ordinary NPCs" (`manager.lua`, `manager-ui.lua`, every `mod/locales/*.lua`, then `node scripts/Extract-UiCatalog.mjs`) would turn the offer off at `reactionOffer` in `mod/init.lua`; nothing else would change.

## Files

| File | Role |
|---|---|
| `mod/npc-reactions.lua` (new) | the kinds per person, `M.allowed` (the rails), the native adapter, the service: `offer`, `start`, `update`, `reset`, `inspect` |
| `mod/gameplay-actions.lua` | the lease carries a `reactionOffer` (private turns of a person with no companion offer); packet `npc-reaction`; `queueReaction`; no screen notice, accepted or not |
| `mod/init.lua` | builds the service (a global, no new upvalue), the two options of the lease, the release, the log, `update` beside `gameplayActions.update`, `reset` with the other services |
| `bridge/companion-actions.mjs` | `parseReactionOffer`, `admit` / `configFor` / `deliver` for `npc-reaction`, the Convai window (`accept`, `contextText`, the action list) |
| `bridge/protocol.mjs` | the input carries `reactionOffer` (dropped when a companion offer is present) |
| `bridge/text-actions.mjs` | the tags (`splitActions`), `reactionNotes`, `reactionMenu` (`pick`, `resolve`) |
| `bridge/text-provider-host.mjs` | the instruction in the reply's notes, the pick after the reply, the hand-over |
| `scripts/development-files.json`, `packaging/release-plan.json` | ship and dev-install `npc-reactions.lua` |
| `bridge/npc-reactions.test.mjs`, `bridge/npc-reactions-lua.test.mjs` | the tests |

No redscript, no new setting, no new notice, no locale string, no new bridge file.

## Tests

- `bridge/npc-reactions.test.mjs` (21): the tags and their cutting (spellings, streaming hold-back, a tag split across the real reply stream, the harmless brackets), which reply counts (end only, once, offered kind), the instruction (short, "rare", only offered kinds, never the others), the offer on the wire and its admission (also through the real `PlayerKnowledge` for an ordinary NPC), delivery, expiry, the Convai window and its context text, and whole turns on Custom (against the loopback mock), Mistral and Local AI (fake chat), including rare-means-rare, per-type actions and companions unaffected.
- `bridge/npc-reactions-lua.test.mjs` (28): the kinds per person (every base of `characters/archetypes.json` has one), every rail, the service on a fake game (first message, once, cooldown, rechecks at start and at run, failures switched off, nothing per frame), the native adapter on a fake game (the exact calls), the lease, and the wiring.

## Live checks owed (CET reload only; the bridge restarts with the game)

See the 2026-10-21 "NPC reactions" entry in `TODO.md` (NPC types, what to say, what should happen, which log lines).

## Open risks

- The prevention calls and the safe-zone reads are called from CET for the first time; every one is guarded, but if one is missing the feature silently loses that outcome (one `NPC reaction: ... failed` line says which).
- A crowd NPC may ignore `AIMoveToCommand` (its crowd AI). The read-back line says the command state.
- A walking-away NPC can be talked to again; its new hold command would stop it.
- A model may never write the tag (a small local model) or write it too often. The instruction is the only lever; measure with the live list.
- Braindances and quest scenes are excluded as far as the game reports them as V's scene tier or a dialogue; a quest that stages ordinary NPCs without raising either is not detectable here.
