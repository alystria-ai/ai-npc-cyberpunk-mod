# Reputation for ordinary NPCs (design, built 2026-10-23 on `feat/reputation`)

A Kingdom Come: Deliverance 2 style standing, for the generic people of Night City only: gang members, NCPD, corporate
guards, nomads, vendors and passers-by (the archetypes of `characters/archetypes.json` and the two residents). It changes how
they talk to V (greeting tone, trust, willingness) and nothing else. **Off by default** (Settings > Conversations >
"Street reputation", `settings.reputation`). Named, story, quest and companion characters never get it.

Research source: the KCD2 bullet in `TODO.md` ("Ideas and features"). What carried over: standing per group and per region,
starting neutral; small steps so it builds slowly; crimes count only when witnessed, and word spreads later; decay toward
neutral; effects through talk only. What did not: KCD2's Unrest, guards' alertness and reinforcements (those would act on game
characters, which the mod never does: [[game-characters-untouched]]).

## 1. What the game exposes (read-only)

| Input | How the mod reads it | Status |
|---|---|---|
| Street Cred | `Game.GetStatsSystem():GetStatValue(V, gamedataStatType.StreetCred)`: the same call `mod/companion-records.lua` makes for `Level` | Pattern confirmed (Level is read live by the companion code); the `StreetCred` enum value **needs live check** |
| V's level | the same call with `Level` (companion-records.lua line 282) | Confirmed in use |
| Lifepath | the world-knowledge scan's `lifepath` (`mod/world-knowledge.lua` readLifepath) and the turn context's | Confirmed in use |
| Finished missions and choices | quest facts and journal states the world-knowledge scan already reads every 30 s and on every journal change (355 allowlisted facts, 638 journal entries in `characters/world-knowledge.json`, writer-verified; `docs/QUEST_DECISIONS.md` 1.2 and 4.2a). They already travel with every turn as the knowledge parts (`bridge/knowledge-parts.mjs`), so the bridge reads them at no game cost | Confirmed (live since 0.2) |
| Gang and faction of a person | `npc:GetAffiliation()` (the archetype classifier, `mod/init.lua` archetypeFacts), `IsCharacterPolice()`, `IsCrowd()` | Confirmed in use |
| Districts | `PreventionSystem:GetCurrentDistrict()` and the district record's parent chain (`currentDistrict()` in `mod/init.lua`) | Confirmed in use; whether Dogtown's root is `Dogtown` or `Pacifica` **needs live check** (handled both ways) |
| Fixers | fixer gig journal entries (`fixers.sts-*`, `fo5.*`, `fr5.*`, `pg5.*` `.quest`/`.completed` keys, allowlisted); the key names the district (Regina: Watson, Wakako: Westbrook, Padre: Heywood, El Capitan: Santo Domingo, Dino: City Center, Mr. Hands: Dogtown) | Confirmed (allowlisted) |
| NCPD heat | `PreventionSystem:GetHeatStageAsInt()` (`mod/npc-reactions.lua`, `mod/turn-context.lua`): read at turn time by the turn context already | Confirmed |
| Crimes | a heat rise is the game's own "a crime was seen" signal. Hook: `ObserveAfter('PreventionSystem', 'ChangeHeatStage')` | Method name from the 2.x scripts; **needs live check** |
| Kills by faction | no counter exists in the game. Hook: `ObserveAfter('NPCPuppet', 'OnDeath')`, killer from `evt.instigator:IsPlayer()` | **Needs live check** (event field name); an unreadable killer is not counted |
| Non-lethal takedowns | `ObserveAfter('NPCPuppet', 'OnDefeated')` | **Needs live check**; if it does not register, defeats are simply not counted |
| Our own reactions | `mod/npc-reactions.lua` (leave, call the police, attack), when one actually starts | Confirmed (live 2026-10-21) |
| Decision ledger | read as an input in principle (`runtime/decision-ledger.json`, `bridge/game-dialogue.mjs`), **not used in v1**: its picks name a quest NPC, not a group, and it has not recorded a live pick yet (QUEST_DECISIONS 4.4). The quest facts above carry the same choices with verified writers. Its files are untouched. | Revisit when the ledger records live |

## 2. Groups

- **Gangs:** `maelstrom`, `tyger-claws`, `valentinos`, `sixth-street`, `animals`, `voodoo-boys`, `scavengers`, `wraiths`,
  `mox`, `aldecaldos` (nomads, also the nomad residents), `barghest`.
- **Law and corps:** `ncpd` (MaxTac too), `arasaka`, `militech`, `kang-tao`, `netwatch`, `nusa`, `biotechnica`,
  `trauma-team`, `corpo` (other corporate security: Zetatech, Corpbud, private firms).
- **Residents per district:** `residents:<District>` for every resident, vendor, joytoy, street goon and corporate worker
  archetype, keyed by the top district (`Watson`, `Westbrook`, `CityCenter`, `Heywood`, `SantoDomingo`, `Pacifica`,
  `Dogtown`, `Badlands`, ...). Regional, as in KCD2: what V did in Watson is not known in Heywood.
- Mercs get no standing (only V's fame, below).

Gangs and corps are city-wide groups; residents are regional. Archetype to group: `bridge/reputation.mjs` `groupFor`
(base first, then the corporate guard's employer, then the category).

## 3. Inputs, weights and steps

Standing runs from -100 to +100, neutral 0. Tiers: **hostile** <= -50, **wary** <= -20, neutral, **friendly** >= 20,
**trusted** >= 50. Steps are small (KCD2's +/-5 on 0-100): a single deed moves a group 2 to 8 points.

| Input | Effect (points) | Witness | Decay half-life |
|---|---|---|---|
| Quest facts and journal states (35 rows, `QUEST_ROWS` in `bridge/reputation.mjs`) | per row, e.g. a clean deal with Maelstrom at All Foods +10 Maelstrom; the NetWatch deal at the mall +10 NetWatch, -15 Voodoo Boys; siding with Judy at Clouds -15 Tyger Claws; the Aldecaldo initiation +25 Aldecaldos | the facts are the game's own record | none (the save holds them); the quest part of one group is capped at +/-60 |
| Fixer gigs finished in a district | +2 residents of that district each, at most +16 | public | none |
| Lifepath | nomad +15 Aldecaldos, +10 Badlands residents; street kid +10 Heywood residents, +5 Valentinos; corpo +5 corporate security, +5 City Center residents | known | none |
| A kill V made in an open fight | -6 the victim's group (police -8 NCPD); a civilian -8 that district's residents and -3 NCPD; +1 each rival group (Valentinos and 6th Street, Aldecaldos and Wraiths, Voodoo Boys and NetWatch, Arasaka and Militech) and +1 NCPD for a gang member | witnessed when V was in combat | 14 game days |
| A kill nobody saw (V not in combat: a stealth takedown) | -1 the victim's group, only after one game day ("bodies are found") | rumour | 14 game days |
| A non-lethal takedown in a fight | half a kill (-3, police -4, civilian -3) | as a kill | 14 game days |
| A wanted episode starts (heat 0 -> 1+) | -3 NCPD, -1 residents of that district | the game raised heat: someone saw it | 14 game days |
| Heat rises a further stage | -1 NCPD | as above | 14 game days |
| Our reactions | a resident who called the police on V: -3 residents; a ganger who attacked V: -3 that gang; someone who walked off: -1 their group | the person itself | 7 game days |
| A decent talk (the third message to the same person with no reaction) | +2 the person's group (residents of the district for residents and vendors), once per person per game day | the person itself | 7 game days |

**Daily caps** (one game day, per group): deeds add at most -20 and at most +8, so one massacre does not saturate a group and
standing builds slowly. **Street Cred** is fame, not liking: it decides whether a stranger has heard of V (below 10: no;
10-19 "some have heard of V"; 20-34 "a known merc"; 35-49 "a big name"; 50 "a legend") and, at 35 or more, a disliked V is
feared rather than defied.

## 4. Witness rule

- A kill or a takedown counts in full only when it happened in an open fight (V in combat, `player:IsInCombat()` at the
  moment): the victim's crew saw it. A quiet kill becomes a -1 rumour a game day later. (KCD2: crime matters when seen.)
- A crime counts when the game itself raised V's heat: the prevention system only does that for a crime it saw.
- Talk and reactions are witnessed by the person V talked to.
- **Word travels:** the group hears at once (gangs and corps talk among themselves); the residents of the district hear one
  game hour later; residents of other districts never.

## 5. Decay

Every deed's points fade toward neutral with the age of the game day it happened on: `0.5 ^ (age_days / half_life)`, half-life
14 game days for violence and crime, 7 for talk and reactions; below 5 percent it is dropped. A game day is about three hours
of play, so a fight fades over a couple of evenings. Quest standing, fixer work and the lifepath never decay: they are what V
did in this save.

## 6. The saved table (per save)

**Lua (game side):** nothing is saved in the game. A ring of the last 64 events in memory, written to
`runtime/reputation-events.json` (`{version, session, events}`, about 6 KB at most) only at a load, a fast travel, the game's
shutdown, or when 64 events wait unwritten. Events also ride inline with the next ordinary-NPC turn, so no write is needed
before a talk.

**Bridge:** `runtime/reputation.json`, `{version: 1, sessions: {<lua session>: <last seq>}, books: {<lifepath>: {buckets}}}`.
A bucket aggregates the deeds of one kind, group, district and game day: `{k, a, x, d, day, w, n, t, c, l}` (kind, group,
detail, district, day, witnessed, count, latest game second, Street Cred and level then). At most 512 buckets per book (the
oldest go), 8 books, 16 sessions: a few tens of KB.

**Per save:** the game's own saved state (facts, journal, lifepath, Street Cred) is per save by nature, so most of the standing
is recomputed from it every turn. Only deeds are stored, in a **book per lifepath**, and every turn applies the **rollback
guard** of the decision ledger: a bucket stamped later than the current game clock, or with a higher Street Cred or level than
V has now, came from a later point or another playthrough and is dropped. A load can only forget, never invent. Residual gap:
two playthroughs with the same lifepath and a similar clock can share deeds until they decay; a native playthrough id (the
save metadata's `playthroughId`, not readable from CET today) would close it (**needs live check**).

## 7. Hooks and events, each with its cost

| Hook or event | When | Work | Cost |
|---|---|---|---|
| `NPCPuppet.OnDeath` (ObserveAfter) | every NPC death in the world | one field read and one `IsPlayer`; for V's kills only: the person's rules (ours, protected, quest), affiliation, police and crowd flags, V's combat state, the district (cached 15 s) and the game clock | about 20-50 us per death, about 0.3-0.6 ms per kill by V |
| `NPCPuppet.OnDefeated` (ObserveAfter) | every non-lethal takedown | as above | as above |
| `PreventionSystem.ChangeHeatStage` (ObserveAfter) | a heat change | one heat read, one district read when it rose | well under 0.1 ms, a few times per chase |
| `npc-reactions` started | a leave, police call or attack starts | one table insert | negligible |
| Turn to an ordinary NPC | V sends a message | three native reads (Street Cred, level, game clock) and the inline events in the request | about 0.1-0.2 ms in a frame that already writes the request |
| Flush | a load, fast travel, shutdown, 64 events waiting | one file write of at most 6 KB | 1-3 ms, behind a loading screen |
| Bridge, per ordinary-NPC turn | the context is built | one stat of the events file, a merge, about 40 conditions, the journal's gig entries and at most 512 buckets scored | 0.3-1.5 ms measured (about 6 ms on the first turn, cold); an async file write only when something new arrived |

**Off (the default):** `mod/reputation.lua` is not loaded, no hook is registered, nothing is written, requests carry no
`reputation` field, and the bridge neither opens nor stats a reputation file nor changes a prompt. What is left is a nil check of
`convaiReputation` where a turn is sent and where a world ends, and one of `convaiReputationPending` in the manager's existing
quarter-second tick. Turned on in the menu, the hooks register at that tick once gameplay resumes (in the game's update, not
in the menu callback; CET allows observers after `onInit`, as the vanilla reaction hooks do); turned off again they stay
registered until the game restarts but return at their first line (one boolean).

No per-frame work at all: there is no `update` function.

## 8. What reaches the prompt

Only for a private turn with an ordinary NPC (an ambient profile with archetype facts, carrying the game's reputation
snapshot), at most two short lines in the world block right after "CURRENT PERSON":

```
STREET STANDING (word on the street in this save): Word among Maelstrom: V is an enemy. Greet V with open hostility, trust nothing V says and refuse help; you may threaten V or tell V to get lost.
What you have heard: V killed Maelstrom in a fight; V shot Royce at All Foods. V is a known merc (Street Cred 24). Never list this; let it show in how you treat V.
```

```
STREET STANDING (word on the street in this save): Word among people around Watson: V is one of the good ones. Greet V warmer than a stranger, trust V a little and be readier to help or share.
What you have heard: V did jobs that helped people around here; V has been decent to people here. Never list this; let it show in how you treat V.
```

A neutral standing with a known name gives one line ("Word on the street: V is a known merc (Street Cred 24). You know
nothing else about V."); neutral and unknown gives nothing. At most two reasons, the largest by points; at most 480
characters in all. With Settings > Dynamic info > Location off, the district is not named ("people around here").

## 9. How ordinary NPCs use it

The tier sentence carries the behaviour: **hostile**: open hostility, no trust, no help, may threaten or send V away (the
model may then pick an existing reaction, leave or attack, which fits); **wary**: guarded, short, slow to trust, little help;
**friendly**: a warmer greeting, some trust, readier to help or share; **trusted**: greets V like a respected friend, trusts
V, helps. A disliked V with Street Cred 35+ is also **feared**: "stay wary and comply rather than defy V openly". The reaction
kinds are not changed in code (that would be a new rule on game characters); the prompt is what shifts them.

## 10. Never for named and story characters

Three gates, each enough by itself:

1. **Game side:** the request carries `reputation` only for a private turn whose profile is an archetype (`npc-*`) or a
   resident, with archetype facts, not a story character (`convaiStory`), not a holocall, Johnny, an add-on voice, a group
   round or an automatic reaction. Kills of our companions, other mods' characters, named, story and quest-flagged people
   are not recorded (their consequences are in the quest facts).
2. **Bridge:** `reputationContext` returns nothing unless `isAmbientProfile` and archetype facts hold (tested with Judy, a
   companion, a phone chat, a group round and a reaction).
3. **No game character is touched:** nothing is written to the game; standing only changes words.

## 11. The setting

`reputation`, boolean, **default off**, Settings > Conversations > "Street reputation", saved in `runtime/settings.json`.
Help text: what it does, that it is only for ordinary people, that named characters are not affected, and that it is light
(no per-frame work).

## 12. FPS and latency budget, and how to measure it

Budget: no per-frame work (none exists); hook work only on deaths, takedowns and heat changes; at most 0.2 ms added to the
frame that sends an ordinary-NPC turn; at most 2 ms in the bridge per turn (measured 0.3-1.5 ms, 6 ms on the cold first turn);
at most two short lines (480 characters, about 120 tokens) in the prompt, so the reply's first token moves by a few
milliseconds at most.

Measure:
- **FPS A/B** (owed, live): the same 2-minute route with a fight against a gang (6+ kills) and a short chase, once with the
  setting off and once on, Developer mode on; compare the FPS median, the worst frame and frames over 25 ms per 2 s window
  (the method of `docs/COMPANION_VISION.md`). Pass: no difference beyond run-to-run noise.
- **Hook cost:** `print(json.encode(convaiReputation:status()))` in the CET console gives the hook call counts and their
  total `os.clock` time.
- **Latency:** the bridge logs one line per ordinary-NPC turn, `[Reputation] group=... standing=... lines=... chars=... ms=...`;
  the stage clock of the turn shows the reply start unchanged within noise.
