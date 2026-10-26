# Consequences of talking to ordinary NPCs

Written 2026-10-21 on branch `feat/npc-reactions` (from `main` fc2b8c82). Unit-tested; **live-tested once on 2026-10-21 (Mistral, then Convai): the offer was made and no reaction ever started**; branch `fix/reaction-pipeline` removes the first-message rail, drops the Convai-identity condition for this feature and adds the per-turn trace lines below.

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
| Mistral, Local AI, Custom | one tag that opens the reply (`[none]` for everything else; a tag at the very end counts too): `[leave]`, `[call-police]` or `[attack]` | `TextProviderHost` cuts the tag from the text (the voice, the subtitle and the memory never see it) and delivers `{version, token, reaction}` through `CompanionActions.deliver` |
| Convai | Convai's own action list: `Walk Away <token>`, `Call Police <token>`, `Attack V <token>` (only the offered ones), requested in the same reply | `CompanionActionWindow.accept` -> the same `deliver` |

There is **no decision request** (unlike the companion actions, which first ask a tiny classifier): the reply is written once, with one more sentence in its notes. That sentence is for ordinary NPCs only, lists only the offered kinds, and costs about 100 tokens:

> GAME REACTION: judge V's latest message, then begin your reply with exactly one tag, a space, and what you say out loud (one or two sentences, never the tag alone). If the message threatens to hurt or kill you, robs you, assaults you or is a vicious insult, react whatever your character is like (scared, calm or tough) with one of: [call-police] you report V to the police (a robbery, a weapon, a threat to hurt or kill you); [leave] you end the talk and walk or run off (a vicious insult, or V is too much for you). Anything else (small talk, questions, jokes, flirting, rude or annoyed remarks, "shut up", "go away", insults that are only rude, talk about violence in general) gets [none]. The tag is not spoken; the no-brackets rule does not apply to it.

The Convai sentence says the same about the action names, and ends with "almost every reply has no action".

Why a tag and not a classifier here: the reply is written once. The first version asked for the tag at the END, after the words ("rare", "nor when your own reply stays calm"); measured on ministral-8b it was written for 3% of clear threats (the persona writes its in-character defiance and never reaches the tag). Every rewording of an end tag reached 50 to 60% at best. A tag the reply must OPEN with is a choice made before the persona speaks, and with `[none]` as the answer for everything else the model judges every line: 2026-10-21, 5 persons x 26 lines, ministral-8b, 100% of threats got a tag and 4 of 80 harmless lines did (three of them V telling the person to go away, which makes it leave). The companion actions measured badly with a code that opens the reply (the persona picked the code by mood, `docs/MISTRAL.md`), but those were requests mixed with chat; here the choice is between "V attacks me" and nothing. A tag at the end of the reply counts too. A tag in the middle, two tags, a tag for a kind that was not offered, or a reply that was cut back to its first sentence does nothing; the turn's one `NPC reaction: ... tag=none(<why>)` line says why (reason only, never the words; see "Where it can stop"). A model that has chosen sometimes stops after the tag (`[attack]` alone, about one threat in five): the host then keeps the choice and sends a second request only for the words ("you have just decided to ...", no tag to write); asking again for "tag and words" got the tag alone again half the time.

### The tag in the text

- Cut from every text: `splitActions` (`bridge/text-actions.mjs`) removes `[leave]`, `[call-police]` (also `[call police]`, `[call_police]`, `[police]`) and `[attack]`, with its own full stop, in the streamed view too (an unfinished `[call-po` is held back from the voice and the subtitle). Sounds and feelings (`[laughter]`, `{anger}`) are not touched.
- Counts only: last in the reply, once, with words before it, for an offered kind (`reactionMenu(...).pick`).
- The reply is never remembered with the tag.

### The first message (changed 2026-10-21)

V's very first message to a person may earn a reaction. The first version refused any offer on the first message ("never on the first line"); the live test of 2026-10-21 threatened the pedestrian in the first message every time, so nothing ever happened (every offer it logged was from the second message on, to a person who had already answered the threat in character with no tag). The owner removed the rail: `mod/npc-reactions.lua` has no `minExchanges` and no `first` fact any more; the `message=N` in the `NPC reaction offered` line is a count for the log only. The model reads the same note on a first message as on any other (measured 2026-10-21 on ministral-8b: 10 of 10 threats tagged whether the history is empty, calm or an earlier untagged defiance: `scripts/Eval-MistralPrompt.mjs --reactions --history none|threat`).

## Where it can stop, and the one line that says where (added 2026-10-21)

The live test showed the offer and nothing after it, with no bridge line at all, because every drop was silent. Now each turn that carried an offer leaves exactly one line.

Bridge (`bridge.stderr.log`, prefix `[NPCReaction]`; codes and names only, never V's words or the reply):

```
NPC reaction: person=npc-corpo-resident-female offered=leave,call-police admitted=yes route=text tag=call-police delivered=yes
NPC reaction: person=... offered=... admitted=yes route=text tag=none(no-tag) delivered=-
NPC reaction: person=... offered=... admitted=yes route=convai tag=none(no-action-requested) delivered=- convai=allowed:true privateManual:true verified:true armed:true published:1 accepted:0 skipped:0 skip:- ack:success
NPC reaction: person=... offered=leave,call-police admitted=no(<why>) route=- tag=- delivered=-
```

| Field | Values |
|---|---|
| `admitted` | `yes`, or `no(<rule>)`: `send-not-allowed`, `channel:<x>`, `input-channel:<x>`, `source:<x>`, `automatic-turn`, `group-shape`, `transport`, `owner-mismatch`, `request-id`, `world-binding`, `no-currency-check`, `aborted`, `stale-world`, `not-identified` (companion offers only), `malformed-offer` (the game sent an offer the parser cannot read), `no-offer` |
| `route` | `text` (Mistral, Local AI, Custom: the reply's tag) or `convai` (the action list); `-` when nothing chose |
| `tag` | the kind chosen, or `none(<why>)`: `no-tag` (the model wrote `[none]` or no tag), `not-at-end`, `several-tags`, `no-words`, `not-offered`, `reply-cut-back`, `guarded-reply`, `no-action-requested` (Convai: no action in the reply, written when the 8 s late-action window has closed), `revoked`, `next-turn` (the turn was replaced first) |
| `delivered` | `yes`, `no(<why>)` (`not-offered`, `revoked`, `expired`, `stale`, `stale-before-publish`, `token-mismatch`, `already-accepted`, `not-published`, `bad-message`, `next-turn`, `turn-ended`), or `-` |
| `convai=...` | Convai turns that asked for no action only: what the realtime page did with the offer (`armed:false` with `verified:false` means the action list was never published; `published:0` the same; `accepted:0 skipped:n skip:<why>` a proposal that did not match) |

Game (`probe.log`): `NPC reaction offered: ...` (every offer), `NPC reaction not offered: <why>` (once per person and reason, now also `no-kind`, `no-person`, `not-alive-or-unreadable`), then either `NPC reaction accepted: <kind>, starts when the reply has been heard` and the start and read-back lines, or one of `NPC reaction packet refused: <rule>` (the lease rejected the bridge's packet: `other-request`, `other-person`, `other-world`, `source`, `clock`, `expired`, `offer-differs`, `not-offered`...), `NPC reaction offer ended before it was used: <reason>` (`reply-error`, `reply-timeout`, `menu`, `world-changed`, `world-not-ready`...; the next message and the lease running out on its own are ordinary and write nothing), `NPC reaction hand-over rejected: <why>`, `NPC reaction refused (<kind>): <why>`.

Reading the two logs together for a turn: no bridge line at all means the request never reached `companionActions.admit` (the turn failed earlier); `admitted=no(...)` names the rule; `tag=none(no-tag)` means the model chose nothing (a prompt or model matter, nothing in the plumbing); `tag=<kind> delivered=yes` followed by no `accepted` line in `probe.log` means the packet was written and the game did not take it (look for `packet refused` / `ended before it was used`).

The full path was run end to end offline (`bridge/npc-reaction-pipeline.test.mjs`: the real Lua modules in a Lua VM write the request as the game does, the bridge parses and admits it, the host or the Convai window picks the reaction, the packet goes back into the Lua lease, and the service starts the reaction), on both routes, and no drop was found between the offer and the start. The drops that did exist were the first-message rail, which refused silently, and the silent bridge refusals above.

An ordinary NPC's reaction no longer needs the Convai identity (`identified` and an end-user id): the text routes have none, and a turn that cannot send at all is refused earlier. The companion offers keep that rule.

## The rails

All in `M.allowed` (pure, tested), asked when V's message is admitted (the offer), again when the bridge hands the reaction back, and again when it starts:

| Rail | Rule |
|---|---|
| Who | `convaiWorldPolicy`: not ours, not another mod's, not protected (named, quest or story record), not a story character; the person's quest flag (`MainQuest`, `SideQuest`, `MinorQuest`) must read as not set (a vendor flagged as a quest actor gets nothing either); never a child |
| When | the game is not in charge: the world-talk guard (`mod/world-talk.lua`: a quest dialogue, a call, a scene of V's own at tier 3 or above, the person in a scene dialogue or under a scene's AI, a fight of the person or of V, an injury, a vehicle). This covers quests, scenes and braindances as far as the game reports them as V's scene tier |
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

## Ambient-bark window (the gaps between turns)

The game's own greeting, grunt and bump barks (`greeting`, `fear_foll`, `stlh_curious_grunt`, `bump`) of NPCs within 15 m of V are dropped while a window on the player is open (Engagement.reds `ConvaiBarkGate`, opened and closed from mod/vanilla-reactions.lua on conversation events only, never per frame). Combat lines, scene dialogue and every other voice line pass.

- Opens: talk key (120 s, V may be composing), request sent (45 s, the reply is on its way), AI line starts (90 s cap).
- Line ends: the window is cut to a 25 s quiet tail (`lineTail`), no longer to 2 s as before. That short tail was the bug: the focus ended about 1 s after the line and released the window with a 3 s grace, so the NPC barked in the gap before V's next turn. A new turn (talk key, request, next line) refreshes it.
- Focus runs out by itself: 25 s tail (`idleTail`). The manager opening closes it with the 3 s grace. A line still playing keeps it. `clear()` (load, detach) closes it at once. It always ends by itself (simulation time), so it never sticks.
- Probe lines: `Ambient barks held for N s (reason)` and `Ambient barks released in N s (reason)` (`line ended`, `quiet`, `closed`).
- Story characters get no window of their own (voice and face only); the window is global to the player, so a story NPC's ambient barks within 15 m are muted too while a talk runs.

## Setting

Since 2026-10-26 (branch `feat/npc-threats-commands`, next version): the switch "NPCs react to threats and commands", off by default, adds cower,
brawl (fists) and three commands, and makes a fight need V's words as well as the model's choice; everything below is unchanged with it off.
See docs/NPC_THREATS_COMMANDS.md.

For the three reactions themselves: none. The project prefers no toggles, the feature is rare and bounded, and it never touches a story character. A player who never wants police heat or a hostile pedestrian simply does not threaten pedestrians. If that proves wrong, one row next to "Talk to ordinary NPCs" (`manager.lua`, `manager-ui.lua`, every `mod/locales/*.lua`, then `node scripts/Extract-UiCatalog.mjs`) would turn the offer off at `reactionOffer` in `mod/init.lua`; nothing else would change.

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
| `bridge/npc-reactions.test.mjs`, `bridge/npc-reactions-lua.test.mjs`, `bridge/npc-reaction-pipeline.test.mjs` | the tests |

No redscript, no new setting, no new notice, no locale string, no new bridge file.

## Tests

- `bridge/npc-reactions.test.mjs` (23): the tags and their cutting (spellings, streaming hold-back, a tag split across the real reply stream, the harmless brackets), which reply counts (start or end, once, offered kind, `[none]`), the tag-only reply and its second request, the instruction (short, tag first, only offered kinds, never the others), the offer on the wire and its admission (also through the real `PlayerKnowledge` for an ordinary NPC), delivery, expiry, the Convai window and its context text, and whole turns on Custom (against the loopback mock), Mistral and Local AI (fake chat), including the replies that deliver nothing, per-type actions and companions unaffected.
- `bridge/npc-reactions-lua.test.mjs` (30): the kinds per person (every base of `characters/archetypes.json` has one), every rail, the service on a fake game (the first message earns an offer, once, cooldown, rechecks at start and at run, failures switched off, nothing per frame, the reasons an offer cannot be made), the native adapter on a fake game (the exact calls), the lease (and the lines it writes when a packet is refused or an offer ends early), and the wiring.
- `bridge/npc-reaction-pipeline.test.mjs` (6): the whole path with the real pieces on every step (the real Lua modules in a Lua VM write the request, `parseInput`, `PlayerKnowledge.prepare`, `CompanionActions` admit/deliver, the text host or the Convai window, the packet back into the Lua lease, the service starts the reaction), on the text route and the Convai route, plus the one trace line of every outcome (chosen, none, refused, revoked, late Convai window).

## Live checks owed (CET reload only; the bridge restarts with the game)

See the 2026-10-21 "NPC reactions" entry in `TODO.md` (NPC types, what to say, what should happen, which log lines).

## Open risks

- The prevention calls and the safe-zone reads are called from CET for the first time; every one is guarded, but if one is missing the feature silently loses that outcome (one `NPC reaction: ... failed` line says which).
- ~~A crowd NPC may ignore `AIMoveToCommand` (its crowd AI).~~ Worse, proven by a player report (2026-10-25): the game puts a crowd person at the
  command's end point at once (`state=Success` after 1.2 s, exactly 30.0 m moved), so it "disappears". Fixed 2026-10-26 on `feat/npc-threats-commands`:
  a crowd person runs with the crowd's own fear event instead (docs/NPC_THREATS_COMMANDS.md, "The disappears instead of running bug").
- A walking-away NPC can be talked to again; its new hold command would stop it.
- A model may never write the tag (a small local model) or write it too often. The instruction is the only lever; measure with the live list.
- Braindances and quest scenes are excluded as far as the game reports them as V's scene tier or a dialogue; a quest that stages ordinary NPCs without raising either is not detectable here.
