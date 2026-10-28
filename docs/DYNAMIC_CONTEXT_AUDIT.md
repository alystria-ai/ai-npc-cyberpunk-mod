# Dynamic context audit (2026-10-12)

> **Update 2026-10-28:** the Follow-up block was removed from the per-turn context (the setting is gone). Sizes below were measured with it, so they are 176 characters high on the turns that carried it.
>
> **Update 2026-10-25:** three more kinds were added, each with its switch and each worded as background, told once and again only on a change (the lesson of this audit: a fact that arrives fresh on every turn is reacted to on every turn): the time since V last talked to this character, in game and real time (`bridge/last-talk.mjs`, decided once per turn id and recorded per memory scope, so the next turn of the same talk is silent), the song on the car or pocket radio and what a TV near V shows (`mod/media-context.lua`), and V's state from Dark Future when it is installed (`mod/mod-state.lua`). See `docs/DYNAMIC_INFO.md`. Companions' and Johnny's unprompted lines (`docs/COMPANION_SPEAK_UP.md`) carry the right-now block and the tracked quest too, which an automatic reaction did not before.
>
> **Update 2026-10-22:** the player can now turn each kind of live info off (Settings > Conversations > Dynamic info) and the place is worded more modestly; see `docs/DYNAMIC_INFO.md`. The tables below describe the 2026-10-12 state.

Read-only audit of what game state the companion AI is told on each turn, how it gets there, what is missing and what to
add first. No code was changed. Requested in `TODO.md`, "Requested 2026-10-12": dynamic context, "continue from game
dialogue", and the later quest-decision check.

How this was checked:

- Read the Lua gatherers (`mod/`), the bridge builders (`bridge/`) and the docs on context.
- Rebuilt the per-turn context offline with the bridge's own functions (`withConversationKnowledge`,
  `conversationContext`, `resolveKnowledge`, the block builders) over the installed game's last real request
  (`CyberpunkConvai\runtime\last-input.json`, 2026-10-11 16:07, Alex) re-aimed at other characters. Sizes below are from
  that, not guessed. Not measured end to end in the running bridge.
- Looked in the installed `probe.log`, `scripting.log` and `perf-probe.json` for evidence of live behaviour.
- Checked that candidate game API names exist in the installed 2.31 script cache (`r6\cache\final.redscripts`, a string
  search). A name that exists there is not proof that the CET call works; those are marked "unverified" below.
- Token figures are characters divided by about 3.7 (quoted game data and JSON run a little under 4 characters a token).

## 1. The path of a turn

```
CET Lua (main thread, at the moment V sends)            bridge (Node)                                  model
-------------------------------------------            ------------------------------------------      ------------------
sendRequest / group round / microphone / phone chat    parseInput (protocol.mjs)                       Convai: connection.
  attachKnowledge: world snapshot + journal history    KnowledgeRouter.prepare                           updateContext({mode:'replace',
  questContext.capture()      tracked quest             -> resolveKnowledge (rules -> facts)               run_llm:'false', text}) before V's
  gameDialogue:capture()      last <=180 s of lines    -> withConversationKnowledge                       text; phone: same context, own
  playerGear:capture()        5 s cache                -> conversationContext (quest-context.mjs)         session
  battles.capture()           last combat              convai-bridge conversationContext adds:        Mistral: one user message
  -> json.encode -> runtime/last-input.json              intrinsic claims, archetype, vendor memory,     "[LIVE CONTEXT ...] <context>
                                                         relationship, phone recap, Natural               V says: ..." after the persona
                                                         speech, Expressive emotions, first-person        (mistral-prompt.mjs buildMessages)
                                                         reminder, Multilingual language
```

- There is one context string per turn. Convai and Mistral get the same string (`config.context`). Mistral wraps it
  with a prefix (`CONTEXT_PREFIX`, 280 characters, same as Convai's `updateContext`) and caps it at 20,000 characters (head 60
  percent, tail kept, `[...]` between). Convai replaces its dynamic info wholesale each turn. Neither route keeps any of it in
  a memory store.
- Everything the Lua captures at send time is on demand. The exceptions are the background collectors in section 4.
- Channels: private text (F6), voice (F7), group (F8), Phone Chat and automatic battle/loot reactions all use the same
  builder, with per-channel differences listed in the table. Automatic reactions get no game dialogue and no gear (their subject is the one event).
  Phone Chat gets no gear.
- Mistral's doc (`docs/MISTRAL.md`) and the header of `bridge/mistral-prompt.mjs` say the context carries "location and
  time". It does not: there is no clock or weather anywhere, and a place only for ordinary NPCs (row 1). Fix the docs, or
  add the data (section 5).

## 2. What is fed now

"Cadence" is how often the game is read. "Tokens" is the approximate cost when the item is present.

| # | Item | Gathered in Lua | Reaches Convai | Reaches Mistral | Cadence | Tokens |
|---|---|---|---|---|---|---|
| 1 | Location and district name | Yes, but only when the addressed character is an ordinary NPC or a spawned archetype copy: `currentDistrict()` in `mod/init.lua` (`PreventionSystem:GetCurrentDistrict`, parent chain for the area) | Yes, for those characters only ("Where you are now: Kabuki, Watson", `archetypeContext`). Named characters and companions: no | Same string, same limits | Once at conversation start | about 20 (the whole archetype block is 267 characters, about 70) |
| 2 | Weather | Added 2026-10-14 (not live): `Game.GetWeatherSystem()` state and rain getters, `mod/turn-context.lua` | Yes: all characters and Phone Chat ("It is raining.") | Same | At turn start, 5 s cache | about 6 |
| 3 | Time of day | Not as a clock. The game time in seconds is read once per world capture (`gameTimeSeconds`, `Game.GetTimeSystem():GetGameTime()`) to order journal events | Only indirectly: "recently" or "a while ago" plus `inGameDaysAgo` in the recent-events section. No hour, no day/night | Same | Once per capture (on demand) | about 0 (the number is in the snapshot, unused for a clock) |
| 4 | In a vehicle | Yes: `player:GetMountedVehicle()` every 0.5 s in the battle sample, plus the car systems | No (used only as a gate for reactions). Convai gets a "drive for me" action offer when V has an owned car (`chauffeurOffer`, a gameplay action, not a statement of fact) | No (no action API) | 0.5 s sample | 0 as a fact |
| 5 | Combat state | Yes: `player:IsInCombat()` and the one hostile NPC V looks at (40 m), sampled every 0.5 s (`mod/battle-observer.lua`) | Yes: `battleContext` (none / fighting / ended, seconds since, duration, observed opponents, witnesses). Manual turns and battle reactions | Same string | 0.5 s sample, read at turn start | about 25 when none, about 150 when a fight is on (569 characters measured) |
| 6 | Health | Added 2026-10-14 (not live): Health stat pool percent, a band (healthy 60 and up, hurt 30 to 59, badly hurt below 30) | Yes when hurt: companions "V is hurt", strangers "V looks hurt"; nothing on Phone Chat | Same | At turn start, 5 s cache | about 5 when hurt |
| 7 | V's gear (added 2026-10-11) | Yes: `mod/player-gear.lua`, `EquipmentSystemPlayerData`, visible item per slot, weapon in hand and slots, cyberware | Yes, `gearContext`, capped at 900 characters; 686 measured on the user's save (11 items). Manual in-person turns only: not Phone Chat, not reactions | Same string | On demand per turn, 5 s cache; `probe.log` shows `Player gear: 11 items` on real turns on 2026-10-11 | about 190 |
| 8 | Current quest and objective | Yes: `mod/quest-context.lua` reads the tracked quest and up to 8 active objectives at send. Background collectors read the journal in full (section 4) | Yes. Tracked journal block (973 characters with one objective: 800 of it is framing), open jobs by category (cap 2,200), recent shared events (cap 1,900; 1,812 for Judy), journal history when the question matches (cap 6,000), and the resolved world facts (cap 8,000; 5,417 for Judy, 7,819 for Johnny) | Same strings | Tracked quest on demand; world and history by continuous background cycles | about 270 for the tracked quest; about 2,000 to 3,500 with the world facts and events |
| 9 | Companions present | Group turns only (audience of up to 3 plus the replies heard). `companions.conversationCandidates(player, 15)` is read for game-dialogue scoping, not sent | Group turns: yes (`groupContext`, about 600 characters with the heard replies). Private turns: no list of who else is with V | Same | Per group round | about 150 in a group, 0 otherwise |
| 10 | Nearby NPCs | Not for context. Auto-connect scans for warm-up only | No (the addressed ordinary NPC gets its own type, vendor kind and district) | No | n/a | 0 |
| 11 | V's gender | No. NPC gender is read for archetype classification only (`GetResolvedGenderName` on an NPC) | No | No | n/a | 0 |
| 12 | V's lifepath | Yes: `PlayerDevelopmentSystem:GetLifePath` is read every world cycle (`lifepath` in the snapshot) | Only as a rule condition. It is never worded. A rule such as "V was an Arasaka corporate" appears when the journal says so | Same | Every world cycle | 0 as a fact |
| 13 | Money | Added 2026-10-14 (not live): `GetItemQuantity` of `Items.money`, turned into a band in Lua (the loot observer still skips it) | Companions in person only, and only broke, low, comfortable or rich; never strangers or Phone Chat | Same | At turn start, 5 s cache | about 6 or none |
| 14 | Wanted level / heat | Added 2026-10-14 (not live): `PreventionSystem` `GetHeatStageAsInt` or `GetHeatStage`, stage 0 to 5 | Companions in person only (stage 1 to 2 "the police are after V", 3 to 4 serious chase, 5 MaxTac); never strangers or Phone Chat | Same | At turn start, 5 s cache | about 10 when wanted |
| 15 | Last events | Combat (row 5), game dialogue (last 180 s, up to 14 lines or 1,600 characters, scoped to the addressee), recent shared quest events (up to 3), Phone Chat recap, pickups only inside a battle-end reaction | Yes, as listed. Pickups do not reach a manual turn | Same | Dialogue by event hooks; others on demand | dialogue block up to 2,700 characters (about 730 tokens), events about 500 |
| 16 | Relationship (romance style) | `mod/relationship-state.lua`: 11 quest facts every 2 s, one file write per refresh | Yes: 182 characters ordinary, up to 1,877 with the affectionate block (`romance-context.mjs`) | Same | 2 s background, read at turn start | 50 to 500 |
| 17 | Character-specific | Native claims for 9 reviewed characters (up to 4,096 bytes), vendor memory for one-shop vendors | Yes | Same | Per turn | up to 1,100 |
| 18 | Voice and style blocks | n/a (bridge only) | Natural speech (2,870 when offered, a share of spoken turns on Omni/Pocket), Expressive emotions (1,393 on a local voice), first-person reminder (187), Multilingual language note | Same | Per turn | 50 to 1,200 |

Present in the table but easy to miss:

- Row 1: a companion or named character is told neither where she is nor what time it is. Only a pedestrian or vendor is
  told the district.
- Rows 4, 11 to 14: the game call is either already made (in-vehicle, lifepath) or one cheap call away, and nothing words it.

### Size of a whole turn (measured offline, V's save of 2026-10-11)

| Character | Base context (`quest-context.mjs`) | Plus the bridge's additions | Total |
|---|---|---|---|
| Alex (1 fact) | 5,023 characters (about 1,360 tokens) | voice blocks | about 6,000 to 9,000 characters |
| Judy (15 facts) | 10,388 characters (about 2,800 tokens): knowledge 5,417, recent events 1,812, journal 973, gear 686, fixed text about 1,300 | relationship 182 to 1,877, Natural speech 0 or 2,870, Expressive 1,393, reminder 187, prefix 280 | about 12,500 to 17,000 characters (3,400 to 4,600 tokens) |
| Johnny (27 facts) | 12,551 characters | plus native claims up to 4,096, plus the same additions | about 15,000 to 22,000 characters |
| Resident (ordinary NPC) | 2,719 characters, see finding B | district block 267 | about 3,000 + voice blocks |

A Johnny turn with Natural speech offered and native claims selected can pass Mistral's 20,000-character cap. The cap
keeps the first 12,000 and the last 7,980 characters and drops the middle, which is where the end of the base context, the
claims and the relationship block sit. Not observed live; the sums are from the block sizes above.

## 3. Findings (all read-only; none fixed in this pass)

**A. Docs say "location and time"; the code has neither.** `docs/MISTRAL.md` ("location and time") and the comment at the
top of `bridge/mistral-prompt.mjs` ("place and time") describe a block that does not exist. District reaches only ordinary
NPCs (row 1).

**B. Ordinary NPCs are given V's quest journal and gear.** `conversationContext` in `quest-context.mjs` does not check
`isAmbientProfile`. Replaying the last real request as `resident-male` produced a 2,719-character context holding "V's
verified current-save journal is shared with you ... answer naturally using the supplied objectives" (V's tracked quest and
objective, 973 characters) and V's gear (686 characters). A pedestrian or food vendor is told the tracked objective as
known. That conflicts with how these NPCs are framed everywhere else (an ordinary person who is not a story character: `archetypeContext`, the ambient persona in `mistral-prompt.mjs`) and spends about 450 tokens on every
ordinary-NPC turn. A bridge-side gate (no journal, jobs, history, gear for ambient profiles) fixes it. Battle and
game-dialogue are already scoped.

**C. The per-turn payload is 796 KB.** The installed `last-input.json` is 796 KB: `journalHistory` 643 KB and
`worldKnowledge` 151 KB, against about 2 KB of everything else. The Lua encodes it with `json.encode` on the main thread
at send time and the bridge parses it. The perf probe (`perf-probe.json`, 2026-10-11 10:46 to 10:51Z) shows `json.encode`
with a maximum of 26 ms in a window. I could not attribute that to this encode, but a 0.8 MB encode at the moment V
presses Enter is the largest single turn-start cost and worth measuring. Only the part the bridge uses (matching quests)
needs to cross the boundary, or the bridge could read the collector's cache from a file the Lua rewrites only when the
journal changes.

**D. Two background collectors run every frame.** `updateKnowledge(delta)` is called from `onUpdate`
(`mod/init.lua`) and steps both collectors every frame:
- `mod/world-knowledge.lua`: 993 observations (355 facts, 638 journal entries) per cycle, at most 32 per frame and a 2 ms CPU
  budget per frame, a new cycle 0.25 s after the last. A cycle is therefore about 31 frames of work.
- `mod/journal-history.lua`: one lane step per frame (active and history lanes with 15 s and 300 s age limits).

They exist so the snapshot is at most 5 s old at the moment of any turn. They are the largest standing main-thread work
among the context collectors and they contradict "on demand at turn start". The perf probe has no row for them (it wraps
module fields, and these are methods of local objects), so their frame cost is unmeasured. Measure them before the C++
work picks targets. The two collectors, the 0.5 s battle sample (`updateBattles`: blackboard reads and a look-at query), and
the 2 s relationship refresh (11 fact reads and a file write) are the standing context work.

**E. The last-pickups block only exists for reactions.** `loot` is attached to battle-end reactions only (`mod/init.lua`
`battleEvent.loot`). A manual turn ("what did you pick up?") never sees the recent pickups although the collector has them.

**F. Quest facts that mention a choice exist, but only for mapped outcomes.** See section 7.

## 4. Cadence summary

| Work | When | Where |
|---|---|---|
| Tracked quest, gear (5 s cache), game-dialogue snapshot, battle snapshot | At turn start (send, voice start and finish, group round start, phone send) | `sendRequest`, `group-chat.lua`, `microphone.lua`, `phone-chat.lua` |
| World facts and journal observations | Continuously, every frame, 2 ms budget, whole cycle about 0.5 to 1 s | `world-knowledge.lua` |
| Journal history (all quests and objectives, text) | Continuously, one lane step per frame | `journal-history.lua` |
| Combat, scene tier, look-at | Every 0.5 s | `updateBattles` |
| Relationship facts | Every 2 s | `relationship-state.lua` |
| Dialogue lines and choices | When the game shows them (event hooks) | `game-dialogue.lua` |
| District | Conversation start, ordinary NPCs only | `currentDistrict()` |

## 5. Proposed additions, ranked by value to conversation

Design rule for all of them: one small module in the style of `mod/player-gear.lua` (read at turn start, 5 s cache, every
call in `pcall`, plain strings only, one `probe.log` line per real read, no timer, no hook, no file). One capture per group
round, shared by the speakers. Total new native calls: about ten per turn, which should be well under half a millisecond;
confirm with the perf probe before shipping. Nothing here needs a per-frame read.

| Rank | Addition | Value | How to get it | Cost per turn | Tokens |
|---|---|---|---|---|---|
| 1 | **Time of day and place for every character**: "It is about 02:40, night, in Kabuki, Watson." | Highest. Lets any companion say it is late, early, that she is hungry, or that the club is near. Today named characters know neither. | Time: the game time is already read once per capture (verified, `world-knowledge.lua`); `Hours` exists among the 2.31 script names. Check the hour against the HUD clock once, because the hour-of-day from the second count (the sample 9,361,340 s is day 108 plus 30,140 s, about 08:22) assumes the clock starts at midnight. Place: reuse `currentDistrict()` (verified live, one call, `PreventionSystem:GetCurrentDistrict`). `GetCurrentZoneType` and `IsInSafeZone` strings exist in the scripts for indoors, outdoors and public/safe zone. They are unverified. | 2 calls | about 25 to 35 |
| 2 | **Who is here and how: party members present, the speaker's own situation, V in a vehicle** | High. A private turn never tells Panam that Judy is also standing there, or that they are both in V's car. | Party: `companions.conversationCandidates(player, radius)` (already used by game dialogue, cheap, no engine query). Vehicle: `player:GetMountedVehicle()` is already used (`battle-observer.lua`) and the car systems already know the mount of each companion (`companions.seatedCandidates`). Her own state (on foot following, sitting, riding, waiting) is module state the mod already holds. Vehicle name through the vehicle record's display name (unverified; the vehicle catalogue may already have it). | 0 to 2 | about 30 to 50 |
| 3 | **V's condition**: health band (healthy, hurt, badly hurt), in combat now, wanted level | High at the moments that matter ("you're bleeding", "cops are on us"). | Health: `GetStatPoolValue` and `GetStatPoolPercentage` exist in the scripts (`Game.GetStatPoolsSystem()`, the Health pool, percent). Combat-now is already sampled every 0.5 s (read the cached boolean). Heat: `GetHeatStage` and `EPreventionHeatStage` exist in the scripts (`PreventionSystem`, which the mod already reads for the district). Both unverified in CET; one read-only probe settles them. | 2 | about 15 |
| 4 | **Who V is**: gender (pronouns) and lifepath, once per save | Medium to high. Other-language replies and third-person remarks to the group need V's gender; "where are you from" needs the lifepath. Lifepath is already read each cycle, so it costs nothing. | Lifepath: bridge-only, it is in `worldKnowledge.lifepath`. Gender: `player:GetResolvedGenderName()`; the same call is used on NPCs in `mod/init.lua` (verified there), `player:GetBodyType()` is the fallback. Read once after load and cache for the session. | 1 per session | about 20 |
| 5 | **Weather** | Medium (atmosphere: rain, smog, heat). | `WeatherSystem` exists in the scripts. The CET getter name is not confirmed here; a one-shot read-only probe (`Game.GetWeatherSystem()` and a method listing) should come first. | 1 | about 10 |
| 6 | **Money and street cred tier** | Medium-low (shopping banter, "we're broke"). | Money: the quantity of `Items.money` through the transaction system, a pattern CET scripts use widely (unverified here). `GetStreetCredTierRecord` and `PlayerStreetCred` exist in the scripts. | 2 | about 10 |
| 7 | **Recent happenings for manual turns**: last pickups (E above), arrival by fast travel, a quest step just finished | Medium. Cheap because the collectors exist. | Attach the loot snapshot the reaction path already builds to manual turns; keep at most 5 items. | 0 | about 60 |
| 8 | **Decisions made in the moment** (section 7): a short ledger of V's dialogue choices | Medium, high for quest talk. | The choice hook of `game-dialogue.lua` (not yet seen firing). | 0 | about 80 |

Not worth adding: a list of nearby pedestrians (needs targeting queries, a real FPS cost), real-world time, V's name (the
game never names V beyond "V").

### Prompt-size budget

- Today a named-character turn is 10,000 to 12,500 characters of base context (2,800 to 3,400 tokens), and 12,500 to 22,000
  with the bridge's blocks. The proposed block (rows 1 to 4, plus 5 when available) fits in **450 characters hard cap
  (about 120 tokens)**, under 4 percent of a typical turn.
- Place it **first** in the context (before the world knowledge). Mistral drops the middle of an over-long context and
  keeps the head and tail; the front is never cut. Convai does not care about order.
- Pay for it: finding B (gate the journal and gear off ordinary NPCs) saves about 450 tokens a turn for them, and the
  fixed text (SPOKEN_OUTPUT 787 characters, CURRENT_AUTHORITY 272, and the journal framing of about 800) has room to
  shrink.
- Heavy characters (Johnny, Regina) should have a bridge-side check that the total fits Mistral's cap, trimming
  natural-speech and the lowest-ranked facts rather than the new block.

### Order of work if approved

1. Bridge-only: findings A and B (docs, ambient gate), plus the lifepath and time lines from data already in the payload.
   No CET reload.
2. A read-only probe of the unverified calls (weather, heat stage, health, money, zone, vehicle name) in the same style as
   the earlier gear probe.
3. The scene module with rows 1 to 4. CET reload and bridge restart.
4. Measure the standing collectors (finding D) with the perf probe before and after.

## 6. Continue from game dialogue

**Goal (TODO):** when V talks to a game character and a spawned companion is nearby, the companion gets that dialogue as
context.

**State: built, unit-tested, installed, never seen firing in game.**

| Piece | Where | Status |
|---|---|---|
| Hooks | `mod/game-dialogue.lua` `install()`, called from `onInit` (`mod/init.lua`, logs "Game dialogue capture unavailable" if it fails) | Four `ObserveAfter` observers: `BaseSubtitlesGameController.ShowDialogLines`, `.OnShowDialogLine` (fallback), `PreventionSystem.OnPlayerChoice`, `InteractionUIBase.OnDialogsData`. All the class and method names exist in the installed 2.31 script cache. No failure line in `probe.log` or `scripting.log`, so install succeeded. |
| Installed copy | `...\CyberpunkConvai\game-dialogue.lua` | Byte-identical to `mod/game-dialogue.lua`. |
| Evidence of firing | `probe.log`, `runtime/game-dialogue-probe.json` | None. The probe file has never been written (`convaiGameDialogue:dump()` was never run) and `probe.log` has no dialogue-hook line, because the module logs nothing on its own. |
| Companion near V | `present` option -> `companions.conversationCandidates(player, 15)` | Wired. Each scene line and each choice stores the profile keys of spawned companions (`state == 'ready'`, attached, alive) within 15 m, up to 6. Only mod-spawned companions count, as intended. |
| Naming the speaker | `resolve` then `resolveName` | A game-placed named character resolves to no profile (the world-policy rule), but the name fallback uses `characterCatalog.resolve` without `world`, so a vanilla Judy line still gets `judy-alvarez`. The code comment says so. |
| Reaching the turn | `sendRequest` (F6), `microphone.lua` (F7), `group-chat.lua` (F8), `phone-chat.lua` | Wired for manual turns; skipped for reactions. |
| Bridge scoping | `bridge/game-dialogue.mjs` `selectGameDialogue` | An episode is used when the addressed character spoke, was the hub of V's choice, or (in person only) was in `present`. So a spawned Panam standing beside V during V's talk with a vanilla River receives the whole exchange, V's lines included, labelled as being in the game. Her own lines are marked "You". |
| Setting | none: it was Settings > Conversations > Continue from game dialogue (on by default) and was removed on 2026-10-20, so the recording is always on | Removed. |

Limits that bear on the user's goal:

- **Window:** lines older than 180 s are dropped, so the companion knows only if V talks to her within three minutes. At
  most 14 lines or 1,600 characters, newest kept (about 2,700 characters, 730 tokens, with framing).
- **Not remembered:** by design the lines are never written to memory (`docs/GAME_DIALOGUE_CONTEXT.md`, "Memory and
  knowledge"). A companion who was beside V an hour ago knows nothing of it unless V mentioned it or the journal covers it.
  If the user wants "helps her follow and assist on the quest", the persistent half is the decision ledger (section 8, item 4),
  not a longer window.
- **Fragile parse:** `parseGameDialogue` is fail-closed. One bad row (text over 600 characters after cleaning, an odd key)
  makes the whole snapshot "unavailable", and the turn simply has no dialogue block. A lenient version would drop only the
  bad row.
- **Automatic reactions** (battle, loot) never get it, by design.
- **Observer coverage is unproven:** a hook on a base-class method may miss calls if the running subclass overrides it
  (unverified, and not visible from outside the game). It would explain "installed, never fired".

What to do to settle it (about five minutes in game; the user plays, I read the trace):

1. Make the proof automatic first: have `install()`'s hooks write one `probe.log` line the first time each hook type fires
   (`Game dialogue: hook show fired`), so a normal session proves it without the console. A small Lua-only change.
2. Then play: stand beside a spawned companion, talk to a vanilla NPC with scripted lines and choices (a vendor with a hub,
   Judy at her apartment), then send the companion a follow-up within a minute. Read the new `probe.log` lines and
   `convaiGameDialogue:dump()`. This covers items 1, 3, 4 and 5 of the 17-item list in `docs/GAME_DIALOGUE_CONTEXT.md`.
3. If neither subtitle hook fires, move the install out of `onInit` to the first gameplay frame with a retry, or hook the
   concrete subclass.

## 7. Quest decisions: does the NPC know which choice V made?

**Short answer: yes for the decisions the reviewed pack maps to a game signal, and the wording says what V chose; no for
the rest.**

What exists:

- **Mechanism:** `characters/world-knowledge.json` is a reviewed rule pack. Lua reads 355 quest facts
  (`Game.GetQuestsSystem():GetFactStr`) and 638 journal entries (state of quest, phase, objective, phone choice or message
  nodes). The bridge evaluates 768 enabled rules against that snapshot and sends the true ones to the character as
  statements (`resolveKnowledge`, cap 8,000 characters, ranked by active quest, relationship, the character's own arcs and
  V's question).
- **Decisions, in words:** 666 of the 768 enabled rules are category `decision`; the rest are quest (71) and relationship
  (32). The statements record what V did, for example "V attended the Clouds meeting with Judy", "V initially backed
  Panam's criticism of Saul's corporate-dependence plan", "V refused to sign the Secure Your Soul contract ... and chose
  to return to Earth". On V's current save Judy received 15 of these, Panam 21, Johnny 27.
- **Honest absence:** the framing says "Missing information is unknown, not a rejected choice", so an unmapped choice is
  not reported as a refusal.
- **Journal state:** the tracked quest and open jobs are also sent, but a journal title or a succeeded quest does not
  prove a choice. The journal-history framing says so.
- **Audience:** 70 characters are declared speakers on at least one rule. A rule is spoken only by its declared speakers
  (plus Johnny, who hears V's rules as a co-witness). Ordinary NPCs and undeclared companions get none.
- **Moment-of-choice:** the choice hook of `game-dialogue.lua` records "V chose the dialogue option '...'" for 180 s. That is
  the only text of an actual choice, and it is ephemeral.
- **Local event ledger and cloud sync:** `quest-memory.mjs` and `knowledge-service.mjs` can record true rules as events and
  replay them as "historical" context (8 events, 2,400 characters), but that needs a verified save identity
  (`fact-identity.lua`, default off) and the cloud sync (`cloudQualified`) is never enabled outside tests. Treat it as
  inactive. I did not verify that live.

What is missing (the doc `QUEST_OUTCOME_COVERAGE_2026-10-05.md` lists the reasons per outcome in
`research/cyberpunk/native-reviews/*-20261005.md`):

| Gap | Size | Why |
|---|---|---|
| Unmapped outcomes | 413 of 1,162 researched outcomes (278 unmapped rows in the pack) | No native signal (optional dialogue, inner choices), only a zero value distinguishes the branch ("zero-only"), a fact shared by several branches, transient facts, or no speaker who can know it |
| Told-by-V rules | 41 | They need disclosure receipts (V told this person). None exist, so they never fire |
| Zero values | within the above | `GetFactStr` returns 0 for a missing fact too, so a 0 counts as unknown unless a presence proof is attached (`factObservation`) |
| Witnesses | most NPCs | A rule fires only for declared speakers; a spawned companion who stood beside V at the choice but is not declared learns nothing |
| Budget | one cap | 8,000 characters for all facts; heavy characters fill it |

What a quest-decision mapping would need:

1. **List the missing decisions that matter** from the 413, by character and by how often V is likely to talk about them
   (the ten review lanes already classify each outcome).
2. **A native signal per decision.** Diff two saves that differ only in the branch (the pack was checked on nine saves
   from five playthroughs) to find a quest fact written on the branch or a journal node that ends differently. For
   zero-only cases use a journal node instead, since the quest system has no existence query.
3. **Rules in the pack format:** `{condition, statement, audience speakers and recipients, evidence}`, each citing
   hash-bound exports, checked against the saves, then `npm run test:knowledge`.
4. **A decision ledger for the rest**, fed by the existing choice hook: when V picks an option, store the tracked quest
   (or hub title), the option text, a stable line id (not only the localised text) and the game time. Persist per save with
   the same world token and reset handling the collectors use, so reloading an earlier save discards later choices. The
   bridge would render at most the last 5 choices as "V chose ..." with the standing "missing is unknown" framing. The
   hook has never been seen firing and the choice index could be off by one (check item 3 of the in-game list), so settle
   section 6 first.
5. **Witnesses:** use the `present` list already stored on each choice as evidence that a spawned companion was there.
6. **Disclosure receipts** for told-by-V rules, or retire those 41 rules. The honest option is to leave them off until a
   transcript-based receipt exists.

## 8. Short list for the user

1. Fix the two bridge-only gaps (the false "location and time" claim, and the journal and gear given to ordinary NPCs).
2. Add a first-in-context "scene" block: time of day, place, who is with V and in what, V's condition, V's gender and
   lifepath, weather when its call is confirmed. About 120 tokens, read at turn start only.
3. Prove the game-dialogue hooks with an automatic log line, then one live pass.
4. Measure the standing collectors and the 796 KB per-turn encode before the C++ work picks its targets.
5. Choose which of the 413 unmapped decisions matter, and decide whether to build the decision ledger.

## Files read for this audit

`TODO.md`; `docs/QUEST_CONTEXT.md`, `GAME_DIALOGUE_CONTEXT.md`, `ROMANCE_DYNAMIC_CONTEXT.md`, `PLAYER_GEAR_CONTEXT.md`,
`MISTRAL.md`, `PLAYER_MEMORY.md`, `QUEST_OUTCOME_COVERAGE_2026-10-05.md`; `mod/init.lua`, `world-knowledge.lua`,
`journal-history.lua`, `quest-context.lua`, `game-dialogue.lua`, `player-gear.lua`, `battle-observer.lua`,
`relationship-state.lua`, `companions.lua` (`conversationCandidates`), `character-catalog.lua` (`resolve`); `bridge/quest-context.mjs`,
`protocol.mjs`, `world-knowledge.mjs`, `journal-history.mjs`, `game-dialogue.mjs`, `battle-context.mjs`, `loot-context.mjs`,
`player-gear.mjs`, `romance-context.mjs`, `group-context.mjs`, `conversation-knowledge.mjs`, `mistral-prompt.mjs`,
`mistral-host.mjs`, `realtime-client.mjs`, `convai-bridge.mjs`; the installed `runtime/last-input.json`, `probe.log`,
`perf-probe.json` and `scripting.log`.

## Status (2026-10-12, later the same day)

Built and unit-tested; not yet live (bridge restart plus CET reload):

- Finding B fixed on the bridge: an ordinary NPC or archetype (`isAmbientProfile`) gets no journal, jobs, history, world facts,
  authority text or gear list from `conversationContext`; it sees only the right-now block and, if the game sent gear, the
  clothing and weapon in hand (`visibleGearContext`).
- Finding A: `docs/MISTRAL.md` and the header of `bridge/mistral-prompt.mjs` now describe what is sent.
- Proposed rows 1 to 4 built as `mod/turn-context.lua` plus `bridge/turn-context.mjs`: game clock, district, people beside V (15 m),
  vehicle, V's gender and lifepath, first in the context, 450 characters at most, in-person turns only. Not done: weather, health
  and heat (their CET calls are unconfirmed; they wait for a live probe), Phone Chat (it has no turn path for the block yet).
  Both were done later: see "Status (2026-10-14)" below.
- Section 6 step 1: each of the four dialogue hooks writes one `probe.log` line the first time it fires per session.

## Status (2026-10-14): weather, health, heat, money, Phone Chat

Built and unit-tested on branch `dynamic-context-2`; not yet live (CET reload plus bridge restart). The four CET reads are unverified API names.

| Fact | Read (`mod/turn-context.lua`, turn time only, inside the existing 5 s snapshot cache) | Companion in person | Stranger (ordinary NPC or archetype) | Phone Chat |
|---|---|---|---|---|
| Weather | `Game.GetWeatherSystem()`: state getter tried by name (`GetWeatherState`, `GetActiveWeatherState`, `GetWeatherStateName`, `GetCurrentWeatherState`), plus `GetRainIntensityType` and `GetRainIntensity` (these two exist in the 2.31 script cache; the state names do not appear there). Kinds: clear, cloudy, rain, heavy-rain, toxic-rain, fog, smog, sandstorm | Yes | Yes | Yes (where V is, like the time) |
| Health | `Game.GetStatPoolsSystem():GetStatPoolValue(id, Health, true)`; value over `GetStatPoolMaxPointValue` as the fallback. Bands: healthy (60 and up, never mentioned), hurt (30 to 59), badly hurt (below 30) | "V is hurt" or "badly hurt" | "V looks hurt" (a bystander can see it) | No |
| Heat | `PreventionSystem` through the scriptable systems container: `GetHeatStageAsInt`, else `GetHeatStage` (`EPreventionHeatStage` Heat_0 to Heat_5). Stage 0 is never mentioned | 1 to 2 police after V, 3 to 4 serious chase, 5 MaxTac | No | No |
| Money | `Game.GetTransactionSystem():GetItemQuantity` of `Items.money`, turned into a band in Lua: broke (below 250), low (below 2,500), ok (below 50,000, never mentioned), comfortable (below 250,000), rich | Broke, low, comfortable or rich only | No | No |

- **Why these audiences:** a stranger sees weather and a visible injury but would not know V's police record or wallet; a text contact is somewhere else, so only the weather (an area fact, like the time) is given, never V's body, wanted state or money.
- **Cost and cadence:** about six native calls per turn window, none per frame, none on a timer. There is no native-plugin sense for any of them (checked the `native-core` branch), so they stay Lua reads. The block keeps its place first in the context, so the prefix cache is untouched; the cap grew from 700 to 800 characters; money is the last sentence and is the first dropped when a block runs long.
- **Failure handling:** every call is in pcall; the getter name that worked is cached; three straight errors skip that read until the next reset; `probe.log` gets one line per failure kind for the whole session (`<fact> read failed (...)`, `answered nothing`, `not recognised (state=... rain=...)`, or a value that cannot be used), and the usual per-window `Turn context:` line adds `weather=kind(state|rain|getters) health=band(percent|read) heat=N(getter) money=band(eddies)` so the next session can check each against the game. Live steps: `TODO.md`, Live checks, "Weather, health, heat and money".
- **Phone Chat:** it already receives the block since 2026-10-13 (`phoneChat.captureTurnContext` shares the snapshot; `bridge/phone-chat.mjs` parses it), so the earlier "not done" note was stale. The new fields travel the same way; the phone wording takes only the weather.

## Status (2026-10-15): where V is, and "Alex thinks we are in her bar"

**The bug (live test, 2026-10-15 01:25 to 01:26).** V stood with Alex in Arroyo (Santo Domingo), outdoors. Alex answered "Either you're here to buy a drink or you're here to leave" and "Like why you're here, or why you're not paying for a drink" (`runtime/bridge.stderr.log`, the `[EmotionTimeline]` lines of requests 13 and 14). The CET log for the same turns (`scripting.log`: `Turn context: 11:55(native) SantoDomingo/Arroyo male corpo vehicle=false party=1 activity=alex=standing ...`) shows the game side was right: district, clock, company and activity were all correct, and the bridge said `Turn context: 6 facts, 401 chars` (a log line that counts facts and never prints them). So there was no stale fact, no wrong district and no wrong mapping. The block read: "You are with V in person, standing near V in Arroyo, Santo Domingo. It is midday, about noon. ..." and then the generic "never claim to be anywhere else". Two gaps let the model fall back to her profile:

1. **The block named a district but said nothing about the spot.** "In Arroyo" does not say street or building, and nothing said that her usual place is not here. Alex's profile (`characters/profile-text/alex.txt`) says she ran the Moth in Dogtown and "the everyday functioning of the Moth", and her first sample line is bartender talk ("You want the house special or something that actually tastes good?"). A small model given no spot and a bar-keeper's voice supplies the bar.
2. **The place came through a naive name splitter.** `placeName` took the last part of the enum name, so a named interior such as `LittleChina_VApartment` read "V Apartment" and `Kabuki_LizziesBar` "Lizzies Bar", and a bar the game really names was never told apart from a street.

**The fix, for every character, in the bridge only (no re-provisioning).**

- `bridge/place-names.mjs` (new): `describePlace({district, area, indoors})` words the place by kind, from the game's own `gamedataDistrict` records (the full list was read from `final.redscripts`): V's apartments ("V's apartment in Megabuilding H10", indoors), the named interiors (Lizzie's Bar, the Afterlife, Misty's Esoterica, Tom's Diner, Viktor's clinic, the Arasaka Tower floors, and so on; indoors), the Badlands records (open country, outdoors), and a plain neighbourhood (Arroyo, Santo Domingo). A named place is stated only when the game's record says V is there.
- `bridge/turn-context.mjs`: a companion in person now also gets, right after the first sentence, "You are indoors." / "You are outdoors, out in the open air, not inside a building." / "You are outdoors, out in open country." when known, or "Which street or building you are at is not given." for a plain neighbourhood on foot (not in a vehicle); and the closing sentence says "Your usual workplace, home and hangouts are not here unless this says so: never greet or serve V as if V had come to them." The cap grew from 800 to 900 characters (the block is cut from the end, so the place and the clock stay). Phone chats, holocalls, strangers and add-on voices are unchanged.
- `mod/turn-context.lua`: an optional, guarded read of the game's own indoor flag. **First version (wrong, failed live 2026-10-15):** `Game.GetSceneSystem():GetScriptInterface():IsEntityInInteriorArea(...)`; the log said `attempt to call method 'IsEntityInInteriorArea' (a nil value)`. The name sat next to `IsEntityInScene` in the script cache's string table, which is a pool shared by every class and says nothing about the owner. **Corrected 2026-10-15 (branch `indoors-vision`):** it is a global script function, `import function IsEntityInInteriorArea( entity : weak< Entity > ) : Bool;` in the REDmod script sources (`tools/redmod/scripts/core/entity/gameEntity.script`, line 5), and a probe compiled against the 2.31 cache with `scc.exe` says `method 'IsEntityInInteriorArea' not found on 'SceneSystemInterface'` while `IsEntityInScene(EntityID)` and `IsEntityInDialogue` resolve. The game uses it itself: `cyberpunk/player/psm/weaponTransitions.script` (`IsEntityInInteriorArea( GetPlayer( gameInstance ) )`: a gunshot carries 25 m indoors instead of the weapon's range) and `core/components/scriptComponents/reactionComponent.script` (a safe area AND an interior area). The flag is the level designers' own interior volumes, so a building V can walk into counts; a bare roof is not claimed. The adapter calls `Game.IsEntityInInteriorArea(player)` (CET exposes script globals under `Game.`; a bare global is the second try), once, only when the turn context is built, never per frame. It sends `indoors` (true or false) and the `Turn context:` line carries `indoors=true(IsEntityInInteriorArea)`, `indoors=false(...)` or `indoors=unknown` (a failed read; the failure is logged once per kind and the field is absent). **Still unconfirmed in game**: whether CET exposes the global under `Game.` and what the flag says in an open-world building; see `TODO.md`, Live checks, "Indoors and fresh pictures". If it never answers, the block falls back to "not given" and, with vision on, the picture decides (`docs/COMPANION_VISION.md`, "Indoors or outdoors").
- The Mature-off prompt pins (`bridge/prompt-pinned.test.mjs`) were re-taken deliberately: the fixture's right-now block gained the two sentences, so Judy's lines a to g, the reaction and the Mature layer changed; the `ctx` and system-head hashes did not.

**Character text (not changed, needs the user's decision).** The turn block now covers the failure for every provider. Profile text that states a workplace in the present tense still pulls a small model toward it, and the Convai profiles live on Convai's servers, so any change there needs `Provision-Characters.mjs --apply` (not run). Present-tense workplace or service lines found by a bounded search of `characters/profile-text/`: alex (sample "You want the house special..."), claire-russell (Afterlife bartender), dino-dinovic ("my bar", "every drunk at my bar"), misty-olszewski (runs Misty's Esoterica), robert-wilson (runs the 2nd Amendment shop), shank (runs the Brainporium), rogue-amendiares (runs the Afterlife), plus mama-welles and pepe-najarro (bartender). Alex's sample line is the one that is addressed to a customer; the others are bios stating a usual place, which is what a bio should do.

## Status (2026-10-21): less weather talk

**The report.** "I find the NPCs always mention the weather... like a lot." Cause: `bridge/turn-context.mjs` stated "It is raining." (and the clock) as a fresh fact in every turn of every kind. A model treats an unprompted fact that comes again and again as something to react to (the add-on voice form was already cut for the same reason, 2026-10-14).

**The fix (bridge only, no setting).**
- The weather and the part of the day leave the right-now block for a short line of their own, `Background (mention only if it matters or V asks): It is late night, about 2 AM. It is raining.`, in the `volatile` tier (the last user message of a text provider's prompt). The right-now block itself, which sits last in the system message, no longer changes when they come and go, so the prefix cache keeps its prefix.
- A conversation hears each only when it is new to it (`bridge/scenery-memory.mjs`): the first turn, a change since the turn before (the weather kind, or the part of the day: late night, early morning, morning, midday, afternoon, evening, night), the first turn after 20 minutes of silence, or when V's words ask (a keyword check: weather, rain, storm, sky, fog, sun... for the weather; what time, clock, hour, morning, tonight... for the clock). Anything else leaves the line out entirely.
- A conversation is one character, one physical NPC (its entity) or one phone contact. The decision is made once per turn id and the same answer returned each time the turn's context is built again (prepared reply, look-ahead, the turn itself, the log line), so a prepared reply and the turn that uses it agree. A turn with no id, no snapshot or a reaction is never gated. The memory is in the bridge only (256 conversations, least recent first), is cleared with the conversation sessions (world reset, key or provider switch), and a restart tells every conversation once more.
- Who gets what is unchanged: health, heat, money, company, vehicle and the rest stay in the block on every turn, with the same audience rules (a stranger never gets heat or money; a phone contact gets the weather where V is and nothing of V's body or wallet).
- The turn-context log line now ends `background=<chars>` or `background=none`, so a log shows whether the weather went along.

**Not changed, for a decision.** Three ordinary-NPC archetypes carry a standing rain flavour in their text (`characters/archetype-profiles/street-resident.json` speaking style "wry humor about money and rain", the same in `characters/natural-speech/npc-street-resident-female.json` "a sigh about rent or the rain", and sample lines in food-vendor and bartender). These are generated files (`scripts/Build-ArchetypeProfiles.mjs --check`), and the fact line is gone on most turns now; if players still hear rain from street residents, soften those two phrases and rebuild.

## Update 2026-10-22: first-turn weather and the archetype place sentence, for every provider

The response audit (`deliverables/response-audit-2026-10-22.md`) measured what the first-turn scenery does: told "It is raining." on a first turn, a food vendor and a bartender mentioned the rain in 11 of 12 replies each, against 1 of 12 and 0 of 12 in dry weather (ministral-8b). Two changes in the shared context builders follow, and **by decision one context serves every provider**: Convai receives them in its per-turn context exactly as Mistral, the Local AI and Custom do (`bridge/convai-bridge.mjs` joins the same blocks; `conversationBlocks`).

- **No weather on the first turn of a conversation** (`bridge/scenery-memory.mjs`). It is told when V asks (a keyword in English and in the languages of the game's menus: cs de es fr hu it ja ko pl pt ru tr uk zh, plus common words for cold, hot, rain, snow, storm, fog and sky; in doubt the weather is included) and when it changes later in the talk. The part of the day is still told on the first turn. A conversation that was silent for 20 minutes starts again.
- **The archetype place sentence** (`archetypeContext` in `bridge/protocol.mjs`) no longer says "Let the place flavor what you say"; it says the person lives with it and never announces the place name or tells V where they are unless V asks.
- Text providers only (Convai's provisioned profile is untouched): rule 7 of the output rules, the lean character text and the copy of the where-sentence before V's words (`bridge/mistral-prompt.mjs`).

Tests: `bridge/turn-context.test.mjs` (first-turn ask in every language, one context for every provider), `bridge/phone-chat.test.mjs`.
