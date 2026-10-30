# Talk to play: small live quests made from what V and a character agree on

Status (2026-10-30): design only. Nothing is built and nothing is seen in the game. The owner decided on 30 Oct to design it now and build it after the quest update
ships. It builds on the quest update (branch `release/quests`: the pack runner `bridge/bond-pack-runner.mjs`, the primitives `bridge/quest-primitives.mjs`, the game side
`mod/quest-play.lua`, `mod/quest-prims*.lua`, `mod/quest-world*.lua`, and the docs [QUEST_PRIMITIVES.md](QUEST_PRIMITIVES.md), [BOND_QUESTS.md](BOND_QUESTS.md),
[RELATIONSHIPS_AND_QUESTS.md](RELATIONSHIPS_AND_QUESTS.md)). Nothing in the quest update's game side has been seen running yet either (its own live list is in
QUEST_PRIMITIVES.md section 8), so this feature starts only after those checks pass for the primitives it uses.

Player requests behind it: FOGH0RN (Nexus, 28 Oct 7:20 PM) and AetherAmoris (Nexus, 27 Oct 9:06 and 9:15 PM), quoted in TODO.md under "PENDING: conversations that lead
to gameplay". Owner's idea: when V and a character agree on something in talk ("let's race", "help me with those Tyger Claws", "get me a drink at the Afterlife"), the mod
turns it into a small live quest made from the quest system's pieces, with a journal entry, a marker, a finish check and a bond reward.

## 0. The design on one screen

* **A talk quest is a generated, one-stage pack.** The quest update already has everything a quest needs: the runner (state, rollback on a load, timeouts, endings, bond,
  memory, history), the play file and event files, the primitives (`place`, `pin`, `together`, `ride`, `race`, `squad`, `gift`, `check`, `cast`, `workspot`) and one cleanup owner
  (`ctx:reap`). A talk quest is a pack that the bridge builds in memory from a piece template plus the slots V and the character agreed on, validated by the same
  `validatePack`, and handed to the same runner. No second quest engine. A hangout (`kind: "hangout"`) is already "a one-stage pack at a place", so a talk quest is
  a hangout whose place and activity were chosen in talk. It gets `kind: "talk"`.
* **Agreement is detected in two steps, never per frame.** A free screen (regular expressions, 16 languages, under 1 ms) decides whether V's line can be a proposal at all.
  Only then does one decision happen, once, after the reply is published: on Convai it is the character's own action choice in the same turn (no extra call), on the text routes
  (Gemini, Local AI, Custom) it is one tiny classifier request of at most 12 output tokens. The game then re-checks everything (the same rule as Eddies and the meet offer: the
  model chooses which game-offered plan V meant, it never invents a place, a faction, an item or a reward).
* **Five first pieces:** meet at a place, drive together, race, fight at a spot, fetch. Slice 1 builds meet-at and fetch, the two with no vehicle and no hostile spawn.
* **Own copies only.** Full gameplay runs on the mod's own copies (party member, invited visitor, housemate) and the quest's own tagged spawns. A character the game placed
  gets talk and nothing else (section 5).
* **Cheap everywhere.** Zero extra Convai interactions per quest. On the text routes one classifier request only on the rare turn whose line passed the screen. No new tick
  in Lua: the quest rides the existing 1 s step of `mod/quest-play.lua`.

## 1. What exists, what does not (read from `release/quests`)

| Need | Already there | Missing |
|---|---|---|
| Run a quest stage with state, rollback, timeout, endings, bond, memory | `bridge/bond-pack-runner.mjs` (entries keyed by pack id, `#tryStart`, `#finish`, `rewind`, `MAX_ACTIVE = 2`, hangout day cap 20), `bridge/bond-packs.mjs` `validatePack` | A pack made at runtime (the runner only loads shipped and community files into `this.packs`). A `talk` pack kind. |
| Game side of every piece | `place`, `pin`, `together`, `party`, `seat`, `cast`, `ride`, `race`, `squad`, `post`, `gift`, `check`, `workspot` in `bridge/quest-primitives.mjs` and `mod/quest-prims*.lua` | All of it is offline-tested on a fake game only. |
| Read V's yes or no | `bridge/bond-intent.mjs` `screenIntent` (yes, no, honest, flatter in 15 languages plus English), `screenMeet` (cancel) | Words for a proposal (race, fight, drink, bring, ride). |
| Pick a companion action from talk | Text routes: `bridge/text-actions.mjs` (screen `bridge/text-action-words.mjs`, then a tiny classifier, `TextProviderHost.#decide` and `decideMeet`). Convai: the per-turn action list (`CompanionActions.configFor`, `bridge/companion-actions.mjs`). Phone: a tag at the start of the reply. | A `play` offer and its rows. |
| Places | `bridge/named-places-data.mjs` (15 places, 6 with exact coordinates of which only the Afterlife and Clouds are venues, 5 `approx`, 4 without coordinates), the developer probe `quest capture:<id>` that writes `runtime/quest-place-capture.json` | A table of places for talk quests (venues, gang spots, race finishes) and their measurement. There is no gang spot data anywhere today. |
| Items | `bridge/gift-tables.mjs` (allowlisted `Items.*` records, likes per character), stage effects `giveItem` and `takeItem`, game side `TransactionSystem` item reads in `mod/quest-world-systems.lua` | Localized item names for slot filling (section 2.3). |
| Vehicles | `mod/companion-vehicle-catalog.lua` (a car record per character), neutral clones without police markers (`mod/quest-tweak.lua`) | Verified in the game: none of it. |
| Show something to the player | Banner notices (`mod/notices.lua`, `docs/NOTIFICATIONS.md`, one catalog entry per notice and a test that keeps them in step), the Relationships page (built on open from `runtime/bonds-status.json`), Phone Chat, map pins (`MappinSystem:RegisterMappin`, variant `CustomPositionVariant`) | A real journal entry is not possible with generated text (journal entries are cooked game resources, QUEST_PRIMITIVES.md section 9 and RELATIONSHIPS_AND_QUESTS.md section 9.1, and the owner chose mod-side state). A pin has no label text. |

Two findings from reading the code:

1. `validatePack` refuses a pack of a character with a shipped arc unless `requires.questsFinished` names one of the character's quests (`bridge/bond-packs.mjs` line 113). A talk
   quest must not need that (V may agree to a drink with Judy before Judy's story is done, and nothing in a drink clashes with the plot). So `PACK_KINDS` gets `talk`, and for that
   kind the rule is replaced by the character's `notActive` arc prefixes only (the "none of their quests is active" part of the plot-safety gate, section 8 of RELATIONSHIPS_AND_QUESTS.md).
   I ran a meet-at pack built the way section 3 shows through the current validator in a scratch file: it validates once those two rules are met (`kind` accepted, `questsFinished` given),
   so no other format change is needed.
2. A reply on Convai streams straight to the voice and a text route's reply must never wait for a decision, so everything here decides after the reply is published, like
   `decideMeet`. The quest starts one to two seconds after the character finished speaking.

## 2. How an agreement is detected

### 2.1 What counts as an agreement

A talk quest starts only when all four hold:

1. **A concrete plan exists.** A piece (race, fight, meet, ride, fetch) and every slot it needs resolved to game data (section 2.3). A vague "we should do something" is not a plan.
2. **V commits.** Either V's own line proposes it in the present ("let's race to the Afterlife", "come help me with the Claws", "bring me a drink") or V says yes to a standing proposal of the
   character's (section 2.5). Questions about ability ("could I beat you?"), conditions ("if we ever..."), wishes, jokes and past tense are not a commit. The same no-list as `gift-intent.mjs`
   is used per language (if, would, maybe, tomorrow, someday, next time, when I). Plans for later ("tonight at ten", "tomorrow") are not started: the character answers in her own words,
   the mod does not keep a calendar. This is a deliberate limit of version 1.
3. **The character agrees.** Her reply accepts (on Convai she calls the offered action, on the text routes the classifier reads V's line and her reply together). A refusal, a delay or "where
   exactly?" is not agreement. If she asks a question to fill a slot, the plan stays open for 3 of V's turns and 10 minutes and V's next line may complete it (the same "pick" pattern as
   `HomePicks` in `bridge/home-requests.mjs`).
4. **The game says yes.** The gate of section 6 passes in the game's current snapshot (not busy, copy present and able, slot places usable, caps free).

Both of the first three must hold, so neither a model that says yes to everything nor a screen that is too loose can start a quest alone. Precision matters more than recall here: a missed
plan costs one repeated sentence, a false start puts a banner, a pin and maybe enemies in front of a player who was only chatting. Targets for the eval (section 10.2): at least 99% precision on
a corpus of ordinary talk, at least 90% recall on plain proposals.

### 2.2 The screen (free, every turn that could matter)

A new code `PLAY` in `bridge/text-action-words.mjs` (the same file and style as DRIVE, FIGHT, FOLLOW, LEAVE: stems per language, Latin and Cyrillic stems at a word start, Japanese,
Korean and Chinese matched anywhere), per piece:

| Piece | Stems (English shown, the other 15 languages follow the table of DRIVE) |
|---|---|
| race | race, racing, beat me, first to, last one there, bet you can't |
| fight | fight, kill, take out, deal with, handle, clear out, go after, help me with those, plus a gang name (alias table, 2.3) |
| meet | drink, grab a, meet me at, hang out, come to, let's go to, head over to, plus a place name |
| ride | ride, drive me to, take me to, take the car to, give me a lift |
| fetch | bring me, get me, fetch, grab me, find me, pick up, plus an item name |

A line passes when one piece's verb stem and one slot word of the same piece (or an unresolved slot with a verb that clearly asks for it) appear. The result is a short list of candidate pieces
(at most 3). Nothing passes for an empty line or the microphone placeholder (`MIC_PLACEHOLDER`). On a typed line the screen runs at once. On a spoken line the recognised text arrives
after the recording (`callLine` pattern), so the screen runs then, after the reply, which is also when the decision runs anyway. Cost: well under 1 ms, no I/O.

### 2.3 Slots: the game owns the data

Slots are resolved by aliases the bridge holds, never by the model:

* **place**: `characters/talk-places.json` (section 4.0). Aliases are the place's English name and its localized names (the game's own localized text, which the game writes once per
  session and language change into a small file `runtime/talk-names.json`, at most 80 short strings). Proper nouns such as the Afterlife are the same in most languages, so the alias list
  is mostly short.
* **faction**: Maelstrom, Tyger Claws, Valentinos, 6th Street, Animals, Wraiths. These are the gangs that `bridge/ambush-context.mjs` and the retaliation records already know, so the
  fighter records exist (AMBUSHES.md notes the game's `gang_retaliation_enemies_*` records and that "no fighter record found" is logged when one is missing).
* **item**: the allowlist of `bridge/gift-tables.mjs`, named by the game's localized display name (written to the same `runtime/talk-names.json`), so V can say the item in V's own language.
* **vehicle**: never from V's words. The character's own car (`mod/companion-vehicle-catalog.lua`) or V's current car.

A slot the words do not settle is asked back by the character (a note in her volatile context: "V wants to race but did not say where, ask where"), not guessed.

### 2.4 The decision, once, after the reply

* **Convai (shared or own key):** the game sends a `play` block with the turn's offer (the same channel as the drive, follow, leave and meet offers): the pieces possible right now
  with their slots already resolved by the game (for example "Race V To The Afterlife"), at most 3, each with a one-use token. Each becomes a named action like
  `Race V To The Afterlife <token>`, plus `Cancel Plan <token>` while a talk quest runs. The character's choice rides on the same interaction that carries her reply, so it is **free**. A second key
  still applies: the bridge accepts the action only if the screen found that piece in V's words. For a spoken turn the offer goes out as a plan (the recognised words come later), exactly
  how reaction plans work today (`pending.planned`, applied when the words arrive).
* **Gemini, Local AI, Custom:** one classifier request after the reply, built like `callMeetClassifier`: no persona, V's line and the character's reply quoted as data, the choices of the
  offer (at most 3, plus NONE), answer one word, `maxTokens 12`, `temperature 0`, `retries 0`, `totalMs 8000`. A failure, a late answer or an unclear one is NONE and logged. On the Local AI it
  is background work that gives way to any turn (the `decideMeet` precedent). No tools or function calling: the repo measured that a tool-calling turn comes back without spoken text and that
  models call tools nobody asked for (the note at the top of `bridge/text-actions.mjs`), and a classifier sees only the two lines and the list.
* **Phone text:** the same tag trick as the meet offer (the reply opens with `[play-race]`, stripped by the game), no second request. This is also free.

The classifier text, sketched:

```
You read one exchange from a video game: what V (the player) just said to a character and how the character answered.
Decide whether V and the character agreed to do one of these things together right now.
RACE: a car race to the Afterlife.   FIGHT: ... (only the choices of this turn's offer)
NONE: anything else (small talk, a question, a joke, a wish for later, a refusal, a delay, the character only asking where or when).
Both V's proposal and the character's agreement must be clear. The exchange may be in any language, slang or with typos.
Answer with one word only: RACE, FIGHT, NONE.
```

### 2.5 Who proposes

* **Version 1: V proposes** ("let's race to the Afterlife"). The character accepts or declines in her own words.
* **Version 2: the character proposes** (section 9.2 of RELATIONSHIPS_AND_QUESTS.md already lists favour templates). The bridge occasionally puts one idea into her volatile note (bond level 3 or more, calm,
  a reach-out style dice with the same caps: one per game hour, three a day across all characters), the note carries a standing proposal that lasts one game hour, and V's "yes" is read with the existing
  `screenIntent` (15 languages) plus her next reply. No new model call: the note rides on a turn that happens anyway.

### 2.6 How V says no or cancels

* **No to a proposal** (before it starts): the character declines, nothing is created, and the same plan with the same character is not proposed again for one game hour. It costs nothing.
* **No to a standing proposal** from the character: same, and her proposals pause for the day after two refusals.
* **Cancel while it runs** ("never mind", "forget it", "let's skip it", "call it off"): `screenMeet(...).cancel` and the `no` words of `screenIntent`, only on a private turn with the character the plan
  belongs to, then the same two-key check (screen plus the character's `Cancel Plan` action or the classifier, whose only choices are CANCEL and NONE). Before the first step (nothing walked, nothing
  spawned) it costs 0, afterwards the `cancelled` ending (small hurt, section 6.4).
* **The Plans page** has a Cancel button for the active plan (no model, no words).
* **Speaking about the plan is not cancelling**: "we're almost at the Afterlife" or "I'm not losing this race" contain no cancel pattern, and only a line that the screen reads as a cancel reaches the decision.

## 3. A talk quest is a generated pack

`bridge/talk-play.mjs` (new, pure) holds the piece table. Each piece is `{id, slots, gate, build(slots, who) -> pack, texts}`. `build` returns a plain format 2 pack. Example, a drink at
the Afterlife with Judy (this exact object passed `validatePack` in a scratch run once `kind: "talk"` is accepted, see section 1):

```json
{"format": 2, "kind": "talk", "piece": "meet-at", "id": "talk-meet-at-judy-alvarez-4821", "character": "judy-alvarez",
 "title": "talk.meet-at.title", "summary": "V and Judy agreed to have a drink at the Afterlife.",
 "requires": {"bond": 1}, "start": {"channels": ["own", "holocall", "phone"], "chance": 1},
 "places": {"spot": {"name": "the Afterlife", "x": -1455.068, "y": 1010.975, "z": 17.824, "radius": 25, "district": "Watson", "captured": true}},
 "stages": [{"id": "go", "type": "play", "label": "talk.meet-at.step",
   "know": "You and V agreed to have a drink at the Afterlife.", "wants": "a drink and a chat with V.",
   "do": [{"p": "party"}, {"p": "pin", "at": "spot"}, {"p": "place", "at": "spot"},
          {"p": "together", "id": "t", "minutes": 6, "metres": 8, "at": "spot"}],
   "choices": [{"id": "stayed", "on": "event:together:t:done", "next": "stayed"},
               {"id": "left", "on": "event:together:t:broken", "next": "left"}],
   "timeout": {"gameHours": 3, "next": "late"}}],
 "endings": {"stayed": {"memory": "You and V had a drink at the Afterlife.", "bond": 6},
             "left": {"memory": "V left before the drink was over.", "bond": -3},
             "late": {"memory": "V never made it to the Afterlife.", "bond": -3},
             "cancelled": {"memory": "V called off the plan.", "bond": 0}},
 "talk": {"capPerDay": 20, "params": {"place": "afterlife", "minutes": 6}}}
```

What changes in the runner (all small, all on the bridge side):

* `startTalk(profileKey, pieceId, slots, gameSeconds)`: builds the pack, validates it, sets it in `this.packs` under a unique id, creates the entry, persists `{piece, slots, startedAt}` in a `talk` section of
  `<state>/bond-packs.json`. `load()` rebuilds the pack from `{piece, slots}` (deterministic), so a restart or a load resumes it. `rewind(gameSeconds)` already drops entries stamped after the loaded
  save, and the pack goes with them.
* A finished or cancelled talk pack is removed from `this.packs` after its closing rows expire (`CLOSING_MS`), its entry stays in `done` form (for the Plans page and the cooldown) for the last 8 only.
* `MAX_ACTIVE` stays 2 across all packs. Talk quests add their own `MAX_TALK_ACTIVE = 1` (section 6).
* The reward goes through the existing ending bond path. For `kind: "talk"` the points use the hangout day cap bucket (`#hangoutBond`, `capPerDay` 20), so hangouts and talk quests share one cap per
  character per game day and cannot be farmed together.
* `afterTurn`, the gap, the tags and the scripted lines are not used: a talk quest has no `say` rows (no prepared audio exists for a generated plan). Her words come from live talk.

## 4. The whitelist: five first pieces

The pieces are a closed list in code. No model-written pack, no player-written template in version 1.

### 4.0 The place data (`characters/talk-places.json`, new)

Rows `{id, kind, names, x, y, z, radius, district, root, faction?, hostileOk, safeZone, source, captured}`. Kinds: `venue` (a bar, club, diner, shop), `lookout`, `finish` (a race finish on a road),
`gang` (an open spot of a gang's turf with room for 2 to 4 people, not inside a safe building). The venue rows start from `bridge/named-places-data.mjs` (the Afterlife and Clouds have exact coordinates,
Lizzie's Bar, El Coyote Cojo, Totentanz, Wakako's office and Judy's apartment are only a streaming cell, about 20 m off, `approx`). Everything else is measured by standing there and running the existing
`quest capture:<id>` probe. A row with `captured: false` is never offered. Target for the first release: 10 venues, 6 lookouts, 8 race finishes, 12 gang spots (2 for each of the 6 gangs). A venue interior
that is a safe zone (clinics, vendors, V's flats, shops with a vendor) has `hostileOk: false` and is never a fight spot.

### 4.1 Overview

| Piece | Says | Slots | Primitives (stage `do`) | Finish check | Fail, timeout | Reward |
|---|---|---|---|---|---|---|
| **meet-at** | "get me a drink at the Afterlife", "meet me at Clouds" | place (venue or lookout), minutes 4 to 10 | `party` or `cast` (self), `pin`, `place`, `together`, `workspot drink` on arrival | `together:t:done` | 3 game hours to arrive: `late`. Apart for 3 minutes: `left` | +6, `left` +3 |
| **ride** | "drive me to the Afterlife", "take the car to Kabuki" | place (venue, lookout or district centre), who drives (V default, or her) | `party`, `seat`, `pin`, `ride {to, limitMinutes 15, heat true}`. If she drives: the chauffeur flow to a waypoint the mod sets | `ride:arrived` | `ride:timeout`, `ride:abandoned` (V on foot 120 s, she is out of the car 20 s), `ride:failed-heat` (no penalty) | +8 |
| **race** | "race you to the docks", "last one there buys" | finish (kind `finish`), `reversed` (slowest wins, only if V said so), the character's car | `cast` (self) with her car, `pin` on the finish, `race {to, from?, vehicle, heat true, limitMinutes 10, headStart 5}` | `race:r:won` or `race:r:lost` (both finish the plan) | `race:r:void` (heat), `:timeout`, `:stopped` (a stander loses in a reversed race). No penalty on a void | +6 either way, the memory says who won |
| **fight-at** | "help me with those Tyger Claws" | faction (6 gangs), spot (kind `gang`, nearest usable, 150 to 800 m from V), count 2 to 4 | `party` (she must be in V's party), `pin`, `place`, `squad {faction, count, hostile on arrival}`, `post fightFrom` for her | `squad:g:down` or `squad:g:fled` | V 200 m away for 60 s while the squad stands: `ran` (one "let's go back" retry). 20 minutes after arrival: `late`. `party:lost`: `alone` | +10 |
| **fetch** | "bring me a bottle of Champaradise", "get me some of those noodles" | item (allowlist), quantity 1 | `gift {dir give, item}` armed, no spawn, no pin | V hands it over in talk ("here, this is for you", read by `bridge/gift-intent.mjs`), the game checks the inventory, takes it, `gift:g:loved/liked/neutral/disliked` | 2 game days: `forgot` | +4, plus the gift's own points (loved +8, liked +4, neutral +1, disliked -4), inside the day cap |

Penalties: a `late`, `left`, `ran`, `alone` or `forgot` ending is -3 (RELATIONSHIPS_AND_QUESTS.md 9.2 priced an accepted favour that timed out at 5, but a casual plan is lighter than a favour she asked for, so 3).
An ending after `cancel` is 0 before any step and -3 after one.

### 4.2 meet-at

* **Place**: venue or lookout from the table. The game picks the instance, the bridge never sees coordinates.
* **Who walks**: a party member is already with V, so `party` plus `place` plus `together` is all of it (she walks or rides along). A visitor or a housemate away from V is sent ahead: `cast` of
  the stage's copy at the place (the walk or car arrival of Immersive invitations, `mod/immersive-world.lua`), and she waits there (the same "waited and stood up" outcomes, `meet:met` and
  `meet:stood-up`, move the pack).
* **Finish**: `together:t:done` (V and the copy within 8 m for the minutes) with a `workspot drink` pose for her at the spot (falls back to `lean` and says so).
* **Reuse**: this is a runtime-made hangout. The hangout pack `jackie-hangout-constellations-of-northside` has the same shape.
* **Variation**: if the place is V's current district there is nothing to walk, so the plan is refused politely ("we're already here") and does not start.

### 4.3 ride

* **V drives**: the `ride` primitive samples V's vehicle at 1 Hz, with the party member seated. Arrival is V's car inside the finish place. The character must be in V's car (the seat flow of
  `mod/companion-seating.lua`) or the plan waits 60 s for her to get in, then ends `abandoned`.
* **She drives**: reuses the chauffeur (`mod/companion-chauffeur.lua`, action `Drive To Waypoint`). The chauffeur needs a map waypoint, so the piece must set one at the place. How to set the
  player's waypoint from the mod is **unverified** (section 12). Until it is, the piece offers only "V drives".
* **Vehicle**: V's current road vehicle. If V has none close, the character says so in her note (the same `no-car` limit as `DRIVE_LIMIT`).

### 4.4 race

* **Fairness**: the finish is 500 to 1500 m from V by straight line, from the `finish` kind (road access checked at capture time). She waits at the line for `headStart` seconds after she sits in her car.
* **Her car**: the record of `mod/companion-vehicle-catalog.lua` for the character, as a neutral clone (no police marker). The race primitive wants her **placed through a cast**, not as a party member
  (`mod/quest-prims-race.lua`), so a party companion is released from the party for the race and rejoins after it. This is the heaviest piece and the least certain in the game, so it comes last.
* **Heat**: a wanted level voids it (`race:r:void`), no penalty.
* **Slow race** (`reversed`): only when V's words say so ("last one there wins", "slowest").

### 4.5 fight-at

* **If real enemies are already around**: when V has gang members of that faction in sight or tagged, the existing companion tactic `Attack Marked Target` (`bridge/companion-actions.mjs`) already does the job and
  no spawn is made. The piece is for "go and find them".
* **Spawn**: at a checkpoint only. The squad is created when V arrives at the spot (never at agreement time), through the same `DynamicEntitySystem` spawner as Revenge ambushes, tagged
  `CyberpunkConvaiQuest` and the quest's own tag, count 2 to 4 (scaled by bond level and V's level, never more than 4 in version 1), hostile on arrival or after `alertAfterSeconds`.
* **The character**: a party member only (she follows and fights with the existing tactics). A visitor or housemate is first asked to join the party ("Join V's Party" is an existing action), or the
  piece is not offered.
* **No grudge farming**: kills of tagged quest spawns do not count toward the Revenge ambush grudge or Street reputation (they are staged, not witnessed crime). To be decided, see question 4.
* **Never**: in a safe zone, inside a building the table marks `safeZone`, near a game quest area that is active, with a wanted level 2 or more, or with fewer than 40% health.

### 4.6 fetch

* **Item**: the allowlist of `bridge/gift-tables.mjs`, preferring the character's `loved` and `liked` rows (so "bring me something" gets a real answer from her likes), plus generic drinks and food.
* **No polling**: nothing watches V's inventory. The check happens when V hands it over in talk (gift intent), the game reads `GetItemQuantity`, takes the item with the existing `takeItem` effect and the
  copy reacts by her likes table. V must be within 10 m of her. If V has the item already, the hand-over can be the same minute.
* **Where**: wherever she is. A character who is not with V is reached the usual way (call and meet), which is the only reason this piece has no pin.
* **Barter, later**: "bring me X and I'll give you Y" is the same piece with a `give` row (`gift {dir receive}`), planned for version 2.

## 5. Who can run what (the "game characters untouched" rule)

| V talks to | What may happen |
|---|---|
| **Party member, invited visitor, housemate** (the mod's own copy) | All five pieces, subject to the piece's own needs (a car for race, party membership for fight-at). |
| **A character the game placed** (story Judy in her flat, Panam at the Sunset, any story character) | Talk only. No piece is offered. Her volatile note says honestly that she cannot do that right now and, where it fits, that V can call and invite her. The mod does not move, seat, arm or drive her, and takes nothing from V on her behalf (the Eddies rule: "a character the game placed only talks about money"). |
| **Ordinary pedestrians** | None. Recruiting a pedestrian is its own feature (RELATIONSHIPS_AND_QUESTS.md section 10) and recruits never join quests. A recruit and a talk quest never run at the same time. |
| **Gang members, vendors, fixers, police, children, androids** | None, and never a role in a plan. The quest's own spawned enemies are tagged copies, not these people. |
| **Johnny** (V's head) | No body. Only a voice-only version could exist (comments during a ride, a fight or a race). Not in version 1. |
| **Songbird** | Never physically there. Not in version 1. She stays with her holocall and text reach-outs. |
| **Jackie** | Only inside his window: the mod's Jackie copy before The Heist is finished and not tracked (the `gate-plus` window). After it, no plan. |

The character's own story arc also gates: the plan does not start while a quest of that character is active (the `notActive` prefixes of `bridge/bond-arcs.mjs`). A character's talk quest and a story pack
or hangout of the same character never run at the same time.

## 6. Safety and immersion

### 6.1 The gate (checked by the game at start, and again at every stage, in the bridge's order)

1. Setting on (section 12 question 1) and Story packs on, Character bonds on (the bond is the reward).
2. **Not busy**: no scene, dialogue choice, combat, game call, vehicle chase (the turn's `busy` flag that `packGate` already uses), no menu or photo mode, not while any loading or fast travel runs.
3. **Main story safe**: no quest under `q114`, `q115`, `q116` and none of the Phantom Liberty finale paths is active. A story fact the game reports as a scene in progress also blocks.
4. **Heat**: wanted level 0 to start. Race voids on heat. Fight-at never starts with heat 2 or more.
5. **The copy** is present, alive, not in a scene, not already carrying another role (not in a recruit, a story pack stage or a hangout).
6. **Caps** (6.2).
7. **Place check**: the chosen place is captured, not in an active game quest area, and for fight-at `hostileOk` and not `safeZone`.

While a running plan has one of 2, 3, 5 false, it **pauses**: no timer runs, nothing spawns, nothing is added to talk. It resumes when they are true. A pause longer than 2 game hours ends it as `late` without a penalty.

### 6.2 Caps and cooldowns (anti-spam, like the bond packs)

* **One active talk quest in total** (`MAX_TALK_ACTIVE = 1`), and it counts as one of the runner's `MAX_ACTIVE = 2` together with story packs. No second plan is offered while one runs: the offer carries
  nothing, so no action exists to call.
* One quest per character: no plan with a character who has an open story pack or hangout.
* **20 game minutes** after any talk quest ends before the next can start. **3 game hours** before the same piece with the same character again.
* **4 plans a game day** in total, **2 per character**.
* A refused or declined plan is not offered again for one game hour. Two refusals in a row from the character's side (her proposals, version 2) pause her proposals for the day.
* **Reward cap**: the 20 points a character per game day of hangouts, shared with talk quests (section 3). The same piece with the same character pays full once a game day, then +1.
* A plan never starts while an automatic remark plays (Johnny, speak-ups, battle remarks), and the speak-up scheduler treats a running plan as busy (the rule of QUEST_PRIMITIVES.md section 5).

### 6.3 If V walks away

| Piece | Rule |
|---|---|
| meet-at | She waits at the place until the 3 game hour timer, then `late` (-3). If V arrives and then leaves (apart 3 minutes), `left`. |
| fetch | Nothing to leave. It lapses after 2 game days, `forgot` (-3). |
| ride | The primitive's own rules: V on foot 120 s, or the copy out of the car 20 s: `abandoned`. |
| race | A stander loses in a reversed race. Otherwise the race runs on without V and ends `timeout` (no penalty if V never started). |
| fight-at | The spawned squad despawns if V is more than 400 m away for 2 minutes with nobody fighting (`ctx:reap`). V 200 m away for 60 s while the squad stands: `ran`, with one "let's go back" retry. |

V dies or loads an older save: the runner's rollback drops the plan, the tagged spawns are swept (they are tagged and the tag is swept once at session start), and nothing is left behind.

### 6.4 Endings and what the character remembers

Every ending has an English `memory` note (what happened, second person) and, for the good ones, a lasting `history` line, written in the piece's data in English only. They are model-facing text, not
player text, so the 16-language rule does not apply to them (the model reads English and answers in V's language). The `memory-share` primitive is not used in version 1.

## 7. Journal entry and marker text

There is no native journal entry (cooked resources, and the owner decided on mod-side state). A talk quest shows itself in four mod-side places. The text is **templated, not generated**: the model
never writes a journal or marker string, so there is no cost, no latency and no chance of a wrong or long line, and a language switch re-renders it.

| Where | What | When |
|---|---|---|
| **Banner** (the game's warning line through `mod/notices.lua`, three new player-class entries `talk-plan-start`, `talk-plan-update`, `talk-plan-end`, 20 s repeat window, added to `docs/NOTIFICATIONS.md`) | One short line: the title, then the end line | Start, a stage change, the end |
| **Map pin** (`pin`, a custom-position mappin, no label text is possible) | The marker itself, placed at the place, removed on arrival, at the end and when cancelled, registered again after a load | While the stage waits on a place |
| **Plans page** (one section on the Relationships page, built when the page opens from `runtime/bonds-status.json`, which gains a `plans` array: active plan with its step text, last 5 ended with their end line, a Cancel button) | The title, the step, the result | On demand only |
| **Phone Chat** (only the end line, from the character, templated) | "Thanks for the drink, V. Same again soon." | At the end of a good plan, never on the shared Convai key's voice |

English source (no dashes, no semicolons, checked by a lint test):

| Key | English |
|---|---|
| `talk.meet-at.title` | Drink at {place} with {who} |
| `talk.meet-at.step` | Head to {place} with {who}. |
| `talk.meet-at.done` | Plan done: a drink at {place} with {who}. |
| `talk.ride.title` | Ride to {place} with {who} |
| `talk.ride.step` | Drive {who} to {place}. |
| `talk.race.title` | Race {who} to {place} |
| `talk.race.step` | Get to {place} before {who} does. |
| `talk.race.won` / `lost` | You beat {who} to {place}. / {who} beat you to {place}. |
| `talk.fight.title` | Take on the {faction} with {who} |
| `talk.fight.step` | Go to {place} and deal with the {faction}. |
| `talk.fetch.title` | Bring {who} {item} |
| `talk.fetch.step` | Find {item} and hand it to {who}. |
| `talk.late` / `left` / `ran` / `alone` / `forgot` / `cancelled` | One neutral end line each, with {who} and the plan title |
| `talk.plans.heading`, `talk.plans.cancel`, `talk.plans.none` | Page strings |

**Languages**: the 16 the mod ships (English, Simplified and Traditional Chinese, Spanish, Brazilian Portuguese, French, German, Italian, Polish, Czech, Hungarian, Turkish, Russian, Ukrainian, Japanese,
Korean), added as a `talk` block to each of `mod/locales/*.lua`. About 36 strings times 15 languages is about 540 short strings: one Haiku agent from the English source with a glossary (game terms such as the
Afterlife and gang names are kept, the character's name is the manager's display name), a lint test for the style rules in English and a key-parity test for the locale files. Slots are filled by the
game: `{place}` from the place row's localized name, `{item}` from the item record's localized display name (`GetLocalizedText` on its `displayName`), `{faction}` from the affiliation record's localized name,
`{who}` from the character's display name.

**Cache**: the strings are static locale data. What is stored per plan is the **piece id, the slot ids and the character key**, never the rendered text, in the entry's `talk.params`. The text is rendered
when shown, in the interface language of that moment, so a language switch is free. `runtime/talk-names.json` (localized place, item and faction names, at most 80 strings) is written by the game once per
session and again only when the interface language changes. Nothing is generated at runtime.

## 8. Provider differences and cost

| | Convai shared key (500 a day) | Convai own key | Gemini free | Local AI | Custom |
|---|---|---|---|---|---|
| Detection | The character's action choice on her own reply, **free** | same | Screen, then one classifier request after the reply | same, background priority, gives way to any turn | same as Gemini |
| Cost of a plan | **0 extra interactions** | 0 | about 150 tokens in, 3 out, only on lines that passed the screen | free (local) | the endpoint's tokens |
| Extra remarks (start or end) | None. Templated banner and Phone Chat only, no model | None by default (question 5) | An automatic turn of the normal kind, at most 2 per plan | same | same |
| Spoken turn | The offer goes out as a plan, applied when the words arrive | same | The classifier runs after recognition | same | same |
| Failure | No action called: no plan | same | 429 or timeout: no plan, no queue, no retry, logged | A busy or loading server: no plan | A slow or failing endpoint: no plan |

Notes:

* **Why no function calling on the text routes**: measured earlier, a tool-calling turn returns only the tool call without spoken text, and models call tools nobody asked for. A classifier that sees
  V's line, her reply and a short list is the reliable form, and it is already the repo's pattern.
* **Gemini limits** (GEMINI.md): about 15 requests a minute and roughly 1,000 replies a day on the free plan. The screen keeps the classifier to a tiny fraction of turns (a line must contain a verb stem and a slot
  word of a piece), and the two optional remarks per plan are the only other calls. A 429 ends the attempt silently.
* **Local AI**: the request is one extra short generation of 12 tokens with at most 3 choices, which small models handle. It runs after the reply is published and yields to any live turn.
* **Convai and the cap**: the shared key's 500 a day is untouched. The plan costs nothing beyond the turn V already made. The finish line on Convai is a templated Phone Chat or subtitle line.
  Only when the provider is not metered, or the player's own key allows it, may the character speak a remark with a live voice.
* **Voice**: with Voxtral, OmniVoice or Pocket the templated banner is not voiced. Her live reply (the agreeing one) already is.

## 9. FPS and latency rules

* **On demand only.** Nothing in this feature runs per frame and nothing adds a tick. All Lua work is: the offer builder, at the moment a private turn's context is built (a boolean, then a distance check of V
  against at most 60 captured places, microseconds), the start command, and the quest's pieces on the existing 1 s step of `mod/quest-play.lua` (place watch 1 Hz near and 0.2 Hz far, race and ride at 1 Hz,
  squad at 1 Hz per member while armed). With no plan the cost is a nil check.
* **No world queries before a plan**: no raycast, no spawn, no vehicle lookup at offer time. Spawns happen at checkpoints only (fight-at on arrival, race car at the start line).
* **No model call in front of any reply.** Detection runs after the reply is published. The plan starts about 1 to 2 s after she finishes speaking (the classifier cap is 8 s, then the plan is dropped
  silently). First-sound latency of a turn is unchanged, with or without the setting.
* **Bridge side**: the screen is a few regular expressions over one line, the pack build is a small object, one atomic state write debounced 5 s (the runner's own). `runtime/bonds-status.json` already exists and is
  written after recorded turns, so the Plans section adds bytes, not writes.
* **Measure**: the stage clock (`promptBuilt`, `published`) with the setting on and off on the Local AI route, the FPS counter during a race and a fight with the plan active versus the same scene with the setting off,
  and the bridge log for the absence of any polling when no plan runs (the same check as item 52 of the QUEST_PRIMITIVES.md live list).

## 10. First build slice (about one day, two pieces): meet-at and fetch

Why these two: neither needs a vehicle or a hostile spawn, so the slice proves the whole chain (screen, slots, decision, gate, generated pack, state, pin, banner, Plans page, reward, cancel) on the least
risky game calls. `fetch` uses a plain inventory read (`GetItemQuantity`). `meet-at` uses `place`, `pin`, `together`, `party` and the invitation flow. Then ride, fight-at and race follow in that order, each
a template plus its slot tables, reusing everything built here.

### 10.1 Work list (about 8 hours)

| Step | Work | Hours |
|---|---|---|
| 1 | `bridge/talk-play.mjs`: piece table, `screenPlay`, slot resolvers, `offerFor(snapshot)`, plus `PLAY` stems in `bridge/text-action-words.mjs` (meet and fetch, 16 languages) | 1.5 |
| 2 | `bridge/talk-play-pieces.mjs`: `build` for the two pieces, `characters/talk-places.json` with the 2 exact venues, `kind: "talk"` accepted in `validatePack`, and `startTalk`, persist, load, rewind and caps in the runner | 2 |
| 3 | Decision wiring: the classifier and parser (`playClassifier`, `parsePlayAnswer`) in `bridge/talk-play.mjs`, called from `TextProviderHost` after the reply like `decideMeet`, then the Convai rows (`Meet V At ... <token>`, `Cancel Plan <token>`) in `bridge/companion-actions.mjs` and the phone tag | 1.5 |
| 4 | Game side `mod/talk-play.lua` (small): the `play` block in the turn snapshot (offer builder), the start command into the existing quest play file, `runtime/talk-names.json`, the three notice ids and rows in `docs/NOTIFICATIONS.md`, the Plans section | 1.5 |
| 5 | Locale keys in English and the 15 other languages (one Haiku agent), lint and parity tests | 0.5 |
| 6 | Offline tests (below) | 1 |

### 10.2 Test plan (offline, the node test runner)

* `talk-play-screen.test.mjs`: recall on plain proposals in all 16 languages, and a negative corpus of ordinary small talk, questions, hypotheticals, jokes and past tense (zero hits).
* `talk-play-slots.test.mjs`: place aliases (English and localized), item aliases, faction aliases, an unresolved slot gives a question note, never a guess.
* `talk-play-decision.test.mjs`: the classifier message holds only the offered choices, answer parsing (case, punctuation, junk is NONE), a failed or late request is NONE, Convai needs both the action and the screen,
  a spoken turn applies the plan when the words arrive, a stale token is dropped.
* `talk-play-gate.test.mjs`: busy, no copy, game-placed character, ordinary NPC, active story arc, Jackie's window, Songbird, heat, caps (one active, 20 minute and 3 hour cooldowns, 4 a day, 2 per character), the plan pause, a
  second plan not offered while one runs.
* `talk-play-pack.test.mjs`: each built pack passes `validatePack`, ends are reachable, timeouts exist, the text lint (no semicolon, no dash used as punctuation) over every template, locale key parity for 16 languages.
* `talk-play-runner.test.mjs`: start, persist, load and resume, rewind to an older save, finish, cancel before and after a step, reward through the shared day cap, closing rows removed, no pack left after the last 8.
* Lua on the fake game (`bridge/quest-lua-fixture.mjs`): the offer builder, the start command, `place` and `pin` for meet-at, the `gift` hand-over with an item present and absent for fetch, nothing armed with no plan.
* An eval script in the style of `scripts/Eval-MistralPrompt.mjs` for the classifier on Gemini and a Local AI model: precision on 200 ordinary lines and recall on 60 proposals per piece.

### 10.3 Live checks (do X, check Y), for the two slice pieces

1. Setting on, a party companion beside V. Say "let's go for a drink at the Afterlife". Does she accept in her own words, a banner appear, a pin sit on the Afterlife, and the plan show on the Plans page?
2. Walk or drive there with her. Does the pin vanish on arrival, the banner say the plan is done after the minutes, and the bond line (Relationships page) rise by 6?
3. Start a plan, then say "never mind, forget it". Does she agree, the pin go, and the page show it as cancelled with no bond change?
4. Start a plan and walk away for 4 minutes. Does it end as left, with a small hurt, and does she mention it once?
5. Start a plan with a companion and fight starts (a scene or combat). Does the plan pause and resume after, with no banner spam?
6. Say "bring me a bottle of Champaradise". Does she agree, and does nothing else happen (no pin, no spawn)? Buy one, stand next to her and say "here, this is for you". Is the item taken and does she react?
7. Say the same thing in a game with a game-placed Judy in her flat. Does she answer in talk only, with nothing created?
8. Language: switch the interface language to German and Japanese. Does the banner and the Plans text change at once, with the place name in the game's own wording?
9. FPS: the counter and the stage clock with the plan active versus the setting off, on Convai and on the Local AI route. No difference?
10. Convai shared key: count interactions before and after a whole plan. Equal to the turns V made?

## 11. Reward summary

Bond points through the existing ending path, inside the shared 20 a day cap per character: meet-at +6 (+3 if V left early), ride +8, race +6, fight-at +10, fetch +4 plus the gift's own points. Every ending writes a
memory note and, for the good ones, a lasting history line, so she brings it up later ("you beat me to the docks"). No eddies, no item and no reputation change in version 1 (question 4).

## 12. Open technical risks (all need the game)

* The whole quest play layer is unverified live (QUEST_PRIMITIVES.md). This feature adds nothing to that risk for `place`, `pin`, `together` and `gift`, but it inherits it.
* Setting the **player's map waypoint** from the mod so that the chauffeur can drive to a named place. Not done anywhere today. Until it is, "she drives" is not offered.
* The race primitive needs the character **placed through a cast, not a party member**. Releasing a party companion for a race and rejoining her is untried.
* Exact positions: only the Afterlife and Clouds are exact. Everything else needs a capture session with `quest capture:<id>`.
* A neutral car for the character (no police marker) is made by `mod/quest-tweak.lua` and unverified.
* Pins have no label text, so the banner and the Plans page carry all the words.

## 13. Decisions for the owner

1. **The setting.** One row under Story packs, **off by default** (hostile spawns and a pin are things a player should opt into), or **on by default** like the decision ledger, or **no toggle at all**
   (your usual preference)? My lean: one row, on by default, with fight-at behind its own sub-choice, but this is your call.
2. **Game-placed characters.** Keep them strictly talk only (the plan is not offered, she says V can call and invite her), or allow the V-only forms with them (fetch with a talk hand-over, go to a place and report back
   by text), which would need an exception to the rule in the memory notes?
3. **Who proposes first.** Ship version 1 with V proposing only, or also let characters suggest a plan now and then (a note in her context, a dice with the reach-out caps: one an hour, three a day)?
4. **Rewards and the grudge.** Bond and memory only for now, or also a small gift from the gift tables or a few eddies for a fight or a race win? And should the fight-at enemies count toward the Revenge ambush grudge
   and Street reputation (lore-honest, but a farming loop), or be staged and not counted (my lean)?
5. **Voice for the finish line on Convai.** Zero extra Convai interactions per plan on every key (templated Phone Chat only, my lean), or allow one live end remark on the player's own key?

## Owner's answers (2026-10-30)

1. Setting: "Plans from talk" is a switch, off by default.
2. Who proposes: both. V asks, and now and then a character suggests a plan in their own style.
3. Game-placed characters stay strictly talk-only. Talk quests run only on our own copies.
4. Rewards: bond points and a memory, sometimes a small gift or eddies, and fight-at enemies count toward Street reputation and Revenge ambushes.
5. Convai cost: not answered yet, so the default stands: zero extra interactions per plan on the shared key.
