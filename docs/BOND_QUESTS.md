# Bond quests: sixty relationship quests for ten characters

Status (2026-10-29): design only, on branch `feat/bonds` (worktree `../wt-bonds`). Nothing here is built, nothing is seen in the game. It builds on
[RELATIONSHIPS_AND_QUESTS.md](RELATIONSHIPS_AND_QUESTS.md) (the bond model, the pack format of section 7.2, the closed effects list of 7.4 and the
plot-safety gate of section 8) and asks for the new pieces it names, in the build order of section 22. The owner reviewed it on 29 Oct 2026 and decided its open questions (section 26). The scripted lines, the holocall scripts and the talk gaps live in [BOND_QUEST_LINES.md](BOND_QUEST_LINES.md).

The owner's ask (29 Oct): "a good amount of gameplay quests, e.g. enemies you spawn at a location, driving a character around, going out on a walk
with a character and spending time, rescuing from a hostage situation etc. Think of several original unique quests for each character, no samey ones,
everything unique, go very deep in designing these relationship quests."

## 0. Scope, decided up front

* **Ten characters**, the evidence-ranked top 10 of the image research, with V's slot (V is the player) given to **Viktor** by the owner: Panam,
  Judy, Johnny, Viktor, Jackie, Rogue, Kerry, River, Takemura, Songbird.
* **Six quests each, sixty in all**, gated across bond levels: the first ones casual, the last ones the most personal thing the character has.
  The default ladder is levels 3, 4, 5, 6, 8 and 10. Jackie and Songbird have their own ladders (their framing, below): Jackie's is 2, 2, 3, 4, 5 and 6 (lowered by the owner on 29 Oct), Songbird's 2, 3, 4, 5, 7 and 9.
* The three example packs already on the branch (Panam's "Ransom for the Mackinaw", Judy's "Dressed for Dinner", Kerry's "Something New") stay as
  they are and are not among the sixty. No quest here repeats their premise (a stolen truck, a dress for a dinner, a new song played for V).
* Every quest is hand-written data in the pack format, with prepared images made ahead in the game's photo-mode look. Nothing is generated at
  runtime except the characters' own words.
* **Three characters need a framing so the game's story is never contradicted:**
  * **Jackie dies in The Heist.** His six quests happen **before** it, in Act 1 Watson (the only district the game opens then), with one of the
    mod's own Jackie copies. They can start once Jackie's prologue quests are done and only while The Heist is not finished, is not V's
    tracked quest and has no scene running (the `gate-plus` window). Once
    The Heist is finished, no Jackie quest starts, and a Jackie quest still open then ends with its own "unfinished" ending (the cruelest ending in
    the document, on purpose: see section 6).
  * **Johnny lives in V's head** from Playing for Time to the end. His quests treat his copy as what the game shows: a figure only V sees and hears.
    Nobody else talks to him, no enemy targets him, he never fights and never touches anything. The gameplay is what V's body does for him, and his
    voice can also come through the bodiless voice route of Johnny in your head.
  * **Songbird leaves Night City in every ending of Phantom Liberty.** Her quests run only on the branch where V let her go, and she is never
    physically there: she reaches V from far away (holocall, Phone Chat, her voice in V's ear), as she did during Phantom Liberty through the
    Relic. V does the gameplay in Dogtown and the city. On the Reed branch there is nothing at all (owner decision of 29 Oct): no quest, no reach-out, no hangout and no gift.
* **Quest gameplay uses the mod's own copies only** (a party copy, an invited visitor, a housemate, and new tagged spawns such as squads, extras and
  captives). A game-placed character still only talks, with face and audio.
* **Added on the owner's word the same day**: scripted lines, scripted holocalls and talk gaps for every quest (text only, pre-rendered voice,
  engine: OmniVoice Ultra), characters who reach out first, 50 free-time hangouts, gifts both ways, animation, music and
  sound fields, and an open pack format for community quests. A trailer is not part of this.
* **Decided by the owner on 29 Oct 2026** (section 26 lists each decision): scripted lines always play as the prepared audio, whatever live voice the player uses, and are English only for now. Quests place map pins at their meeting points (`pin`). Jackie's gates are lowered. Songbird has nothing on the Reed branch. Kerry's Guinevere gift is allowed and changes the save. Reach-outs are on by default with Story packs, with a setting to turn them off. The scripted lines moved to their own file, [BOND_QUEST_LINES.md](BOND_QUEST_LINES.md).

How the document is laid out:

| Part | Sections |
|---|---|
| The frame | 0 to 3: scope, how a quest is written, the vocabulary, the rules |
| The characters | 4 Panam, 5 Judy, 6 Johnny, 7 Viktor, 8 Jackie, 9 Rogue, 10 Kerry, 11 River, 12 Takemura, 13 Songbird. Each holds its six quests, then a pointer to its scripted lines and talk gaps (now in BOND_QUEST_LINES.md), its reach-out triggers, its five hangouts and its gift lines |
| The systems | 14 scripted lines, holocalls and gaps, 15 reaching out first, 16 hangouts (with the registry of all fifty places), 17 gifts (with the item ids), 18 community quests (format 2, schema, validation, example), 19 animation, music and sound |
| The checks and the plan | 20 the sameness check, 21 the primitives with counts and sketches, 22 the build order, 23 failure and retries, 24 memory, 25 the rendering estimate, 26 owner decisions, appendix A the points to verify |

Panam and Judy were written by the lead designer as the worked examples, the other eight by two helpers from them, and the cross-character
sameness pass, the systems and the primitives by the lead.

## 1. How each quest is written

```
### P3. Title (`pack-id`)
Gate:     bond level, the character's quests that must be finished (journal paths, with the quest names), what must not be active,
          relationship, settings needed
Premise:  why this is happening now, in the character's canon
Stages:   numbered, each with its gameplay type (in bold), its place (a real Night City, Badlands or Dogtown place), what V does,
          and its success / fail / branch conditions
Talk:     the beats the character should steer toward (notes for the stage's know/wants, never a script)
Outcomes: the endings, each with its bond change, its rewards and what the character carries into later talk
Images:   the prepared images, each a brief for the image artist (a game-look photo in the photo-mode style), and when it is sent
Build:    each gameplay type mapped to an existing mod piece, a new primitive (named, section 15) or "hard" (why)
Pins:     the meeting points that get a map pin (optional, rule in section 3)
Lines:    a pointer to the quest's scripted lines, holocall scripts and talk gaps in BOND_QUEST_LINES.md
```

A gate written `sq027_02` means the journal path `quests/side_quest/sq027_02_raffen_shiv_attack`. Every pack also gets the arc's own `notActive`
prefixes and the main-story end guard from section 8 of the system doc, so they are not repeated in each gate. Levels: 3 Friendly, 4 Friend,
5 Good friend, 6 Close friend, 8 Confidant, 10 Ride or die.

## 2. The vocabulary the quests use

Existing mod pieces (each is built, though several are not yet seen live, as their own docs say):

| Name | What it is | Where |
|---|---|---|
| `talk` | the pack runner: stage notes, choice tags, timers, endings (phase 2 of the system doc) | `bridge/bond-packs.mjs` |
| `meet` | an Immersive invitation: she travels to here, home or V's waypoint, waits, joins, or is stood up | `mod/immersive-invitations.lua` |
| `eddies` | money both ways with a story reason (ask, repay, gift) | `bridge/eddies.mjs`, `mod/eddies.lua` |
| `text`, `holocall` | a Phone Chat message (fixed line on the shared key), a holocall V makes | `mod/phone-chat.lua`, `mod/holocall.lua` |
| `party` | the copy follows V on foot and rides in V's car as a passenger | `mod/companions.lua`, `mod/companion-vehicles.lua` |
| `chauffeur` | the copy drives V to the map destination in V's car or her own | `mod/companion-chauffeur*.lua` |
| `her-car` | her own car arrives with her, and can be blocked or returned by a stage | `mod/immersive-car.lua`, `vehicleBlocked` / `vehicleReturned` |
| `seat`, `settle` | she sits beside V on the same furniture, settles at V's flat | `mod/companion-seating.lua`, `mod/companion-settle.lua` |
| `outfit` | the copy wears another of her own appearances | `mod/companion-outfits.lua` |
| `gestures` | conversation gestures and signature idles | `mod/companion-gestures.lua` |
| `fight` | the copy fights a tagged or looked-at target, holsters after | `mod/companion-tactics.lua`, `mod/companion-equipment.lua` |
| `npc-react` | an ordinary NPC leaves, calls the police, attacks, cowers, brawls or obeys after what V says | `mod/npc-reactions.lua` |
| `archetype-talk` | talk with an ordinary NPC of a kind in a district, reported by kind and district | the archetype route |
| `district`, `heat` | the district V is in (event on change), the wanted level | `PreventionSystem` reads, already used |
| `radio` | the station and song on V's car or pocket radio, from the game's own song events | `mod/media-song.lua` |
| `gear` | what V visibly wears and carries | `mod/player-gear.lua` |
| `items` | give V an allowlisted item, take one V has (unverified for non-money items) | `giveItem` / `takeItem` |
| `johnny-voice` | a voice with no body in V's ear (Johnny in your head's route) | `mod/johnny-head.lua` |
| `battle-remarks` | a companion's short remark after a fight event | `mod/battle-reactions.lua` |
| `squad-spawner` | the Revenge ambushes squad: faction fighters copied through `DynamicEntitySystem`, hostile, tagged, cleaned up | `mod/revenge-ambush-world.lua` |

New primitives (short names here, each sketched in section 15 with its technical plan and the number of quests that need it):

| Name | One line |
|---|---|
| `place` | a fixed place shipped with the pack (point, radius, words): "V arrived", "V left", checked on district events and a slow poll only while a stage waits |
| `pin` | a map pin on a meeting point ("meet Panam here"), registered with `MappinSystem:RegisterMappin` and registered again after every save load |
| `squad` | a pack's own enemies at a place: faction, kinds, count, waves, relaxed or alert, success when down, fail when V leaves |
| `together` | timed presence: V and the copy within a few metres for N game minutes, optionally seated or at a place |
| `ride` | V drives with the copy as passenger: arrival at a place, with optional route checkpoints, time limit, no heat |
| `image` | a prepared image sent in the Phone Chat message row at a stage moment, with a fixed caption |
| `hostage` | a neutral captive spawned at a place (an extra or one of the mod's copies), success if alive when the squad is down |
| `unseen` | stealth: V reaches a place or does a thing without the squad or V entering combat |
| `post` | the copy walks to a fixed spot and holds it (overwatch, lookout, getaway driver) |
| `remote` | the character's short checkpoint lines in V's ear or on a holocall, with no body present |
| `runner` | a spawned car or bike that drives a fixed route away from V: caught, stopped or lost |
| `convoy` | two or three friendly spawned cars in a column to a place |
| `cast` | an extra person for a stage: a nameless extra or one of the mod's copies of another character |
| `race` | the copy drives her car to a finish place while V drives, first to arrive wins |
| `workspot` | a chosen vanilla workspot on the copy at a place (guitar, smoking, leaning on a rail, dancing) |
| `check` | a one-time read at a checkpoint: V's look, the song on the radio, the hour, the weather, the heat, an item V has |
| `gate-plus` | new gate fields: quest facts, "before" (a quest not yet begun), story windows |
| `call-in` | the character calls V (a holocall the mod starts) |
| `history` | a lasting line of shared history the character keeps (beyond the ending's 3-day note) |
| `memory-share` | a related character learns what happened (talk only for game-placed ones) |
| `garage` | the game's own "add vehicle to V's garage" call. Allowed by the owner on 29 Oct for Kerry's Guinevere gift only, it adds the car to V's garage for good and changes the save |
| `line`, `gap`, `call-script` | a pre-rendered scripted line, a talk gap where the script waits for V, a scripted holocall (section 14) |
| `reach-out`, `hangout`, `gift` | the systems of sections 15, 16 and 17 |
| `music`, `sfx`, `anim`, `situation` | the fields of section 19 |
| `tail`, `bout`, `escortee`, `hold-until`, `dead-zone`, `apart` | smaller loops the helpers needed, sketched in section 21 |

## 3. Rules every quest follows

* **Copies only.** Every body a quest moves, dresses, seats, arms, spawns, captures or drives is one of the mod's own copies or a new tagged spawn.
  A game-placed Judy in her flat only talks. The bad-talk reactions and recruited pedestrians are the owner's two exceptions and quests do not need
  them.
* **Nothing per frame.** A stage that waits on the world arms one watch (section 15, `place`), at most 1 Hz, only while that stage is current, and
  only for what it waits on. Spawns happen at checkpoints. A quest that is not on the current stage costs nothing. A turn carries one short note.
* **Latency.** No quest adds a model call to a turn, and nothing runs in front of the reply. Checkpoint remarks are automatic turns of the same
  kind as battle remarks (a fixed line on the shared Convai key).
* **Plot safety.** The section 8 gate of the system doc for every start, and a pause (no stage moves, no timer runs) while any of its conditions is
  false. A quest is never set inside a place where a game quest of that character is still to happen.
* **No new content limits.** Characters react freely, flirt or refuse as they are. Bond levels change trust, not what may be said.
* **Variety.** No two quests share a core loop and a setting, each character's six use different gameplay types, and nothing is a plain fetch or
  kill job (the sameness pass, section 14).
* **Pins.** A meeting point gets a map pin ("meet Panam here", the `pin` primitive) when the invitation or the stage names it, and the pin is gone when V arrives, when the stage ends and when the quest ends. Pins are registered with `MappinSystem:RegisterMappin` and registered again after every save load, because the game does not keep them. Places V has to find alone (S4's find-it-from-memory route, R4's hidden route, any `place` with a hint ladder) get no pin, and so does nothing else.

---

## 4. Panam Palmer

Canon anchors: an Aldecaldo who walked out after a quarrel with Saul, back with the family after Ghost Town, a driver, a marksman and a planner who
hates being called impulsive and fears failing people who trust her. Mitch and Scorpion are old friends, Cassidy an older family friend who helped
when Raffen Shiv took a childhood friend of hers, Carol the family's netrunner. Her truck is the Mackinaw (`her-car`). The Basilisk and the Raffen
war are behind her by the last quests. Ladder: 3, 4, 5, 6, 8, 10.

### P1. Coffee at the Sunset (`panam-sunset-coffee`)

Gate: bond 3, `q104_02_av_chase` (Life During Wartime) finished, no `q104`, `sq004` or `sq027` quest active. Any relationship. Needs Immersive
invitations.

Premise: since Ghost Town, Panam keeps the motel room at the Sunset Motel in Rocky Ridge as the one roof she sleeps under. She has a rare free
morning, terrible motel coffee, and nobody to complain about it to. It is the first time she asks V for nothing but company.

Stages:
1. `invite`: **talk + text**. She texts at dawn game time (or says it in person): "coffee's awful, view's not, come out". `meet` at a `place`, the
   Sunset Motel forecourt, within 3 game hours. Stood up: ending `cold-coffee`.
2. `walk`: **walk / hangout**, `party` + `together` (5 m, 20 game minutes). She walks V around Rocky Ridge: the motel, the gas station, the
   lookout behind the motel where she watches the road. The timer counts only while V stays with her. V driving off ends it early (`left`).
3. `sit`: **sit together**, `seat` on the motel's outdoor bench or the room's couch (`together` seated, 10 game minutes). The sun comes up.
   Choice tags: V tells her something real about V's own life (`shared`) or keeps it light (`light`). Both go to `sunrise`.
4. `sunrise`: closing beat, a prepared `image` sent by her after V leaves.

Talk:
* the mock-formal review of motel coffee she cannot resist, the "extras" of the motel room
* why she keeps a room at all when nomads rarely sleep under a roof, and what it says that she does
* the road, the Badlands at dawn, how she reads weather from the dust
* a question back to V, sharp and curious: what V would be doing if V were not in this mess
* (`shared`) she answers in kind with something small about growing up on the road, not her big wounds yet

Outcomes:
* `sunrise` (+45): "You had coffee with V at the Sunset Motel at dawn and showed them Rocky Ridge." `history`: she mentions "our motel mornings".
* `sunrise` with `shared` (+55): as above plus "V told you something real about their life."
* `left` (+15): "V came out to the Sunset for coffee but did not stay long."
* `cold-coffee` (-5): "You asked V out for coffee at the Sunset and they never came." She teases V about it once.
* Rewards: none (it is the casual one).

Images:
* `sunset-coffee.png`, sent at `sunrise` with "proof the view was worth it": two chipped motel mugs on the hood of the Mackinaw, the Sunset Motel
  sign out of focus behind, low orange sun over the Badlands, dust in the air, game-look photo mode, no faces.

Build: `meet` at a `place` (existing invitation, place is new), `party` + `together` (new), `seat` (existing, needs a "seated together" event),
`image` (new), `history` (new).

Pins: the meeting point, the Sunset Motel forecourt.

Lines: see BOND_QUEST_LINES.md, Panam P1

### P2. Toll on the Old Highway (`panam-wraith-toll`)

Gate: bond 4, `sq004_riders_on_the_storm` finished, none of her quests active. Any relationship. Eddies optional.

Premise: the Wraiths have put a toll on the old highway south of Rocky Ridge, a burned-out bus across the road and a few guns. Aldecaldo runs
pay or turn back. Panam wants to know how many there are and whether they bluff, and she does not want the clan to start a war over it. Her plan:
V drives up to the barricade and talks while she lies on the ridge with her rifle.

Stages:
1. `plan`: **talk**. She lays it out in steps, as she does. Tags: V agrees (`in`), V wants to go in shooting (`loud`, she argues, then agrees
   to cover it), V refuses (`no` -> ending `pass`).
2. `overwatch`: **post + squad**. At the `place` (the barricade on the old highway south of Rocky Ridge) a `squad` of 4 Wraiths (relaxed, not hostile
   until provoked) stands at the bus. Panam takes a `post` on the ridge 80 m off, prone with her rifle. She speaks only through `remote` lines
   ("the one on the left is twitchy"). V drives up and talks to the Wraith boss, an ordinary NPC with the Wraith archetype.
3. `toll`: **negotiation by talk (npc-react)**, one of three branches decided by the Wraith's reaction:
   * V pays (an `eddies` payment to the toll keeper, 500 to 1,500 by V's offer: a new small "pay an NPC" flow) -> `paid`.
   * V talks them into leaving (the threats route: `npc-react` leave or cower) -> `bluffed`.
   * Shots fired (V attacks, or the boss turns hostile after an insult): the squad goes hostile, Panam fires from the post (`fight` from the
     post, her copy's weapon), 2 more Wraiths arrive by car after 30 s (wave 2). Down: `cleared`. V more than 200 m away while they stand: `ran`.
4. `debrief`: **ride**. She comes down, gets in V's car (`party`) and V drives her back to the Sunset Motel `place`.

Talk:
* her sequence-style planning, the "are you with me" check, terse imperatives on the radio
* if V wants it loud: her irritation at being called impulsive turned around on V, "now who's the hothead"
* afterwards, depending on the branch: respect for a clean bluff, a grudging "money's money" for the toll, adrenaline for the fight
* the Wraiths as the thing her family fears for the kids on the roads, and her fear of failing people who trust her

Outcomes:
* `bluffed` (+55): "You covered V from the ridge while V talked the Wraiths off the old highway without a shot." She retells it to Mitch (talk).
* `cleared` (+50): "You and V cleared the Wraith toll on the old highway, you from the ridge, V on the road." Reward: 1,000 eddies from the
  clan, her share (`eddies` gift).
* `paid` (+35): "V paid the Wraiths' toll so nobody got shot. You are not sure that was right." Later talk: she wonders if they will be back.
* `ran` (+5), `pass` (+0, she goes with Mitch instead, and mentions it).
* `memory-share`: Mitch's copy (if V has one) knows the story.

Images:
* `wraith-toll-scope.png`, sent at the end: the view through a rifle scope from a ridge, a burned bus across a desert highway, V's car small at the
  barricade, heat haze, crosshair, game-look photo mode. Caption in her voice: "you looked taller from up here".

Build: `place`, `squad` (new, on `squad-spawner`, relaxed start), `post` (new), `remote` (new), `npc-react` (existing, on the squad's boss: needs the
squad's boss to be talkable as an ordinary NPC, which squad members are, by archetype), a new `eddies` flow "pay an NPC" (small), `fight` from a post,
`ride` (new).

Pins: the meeting point, the meeting spot south of Rocky Ridge, where she lays out the plan.

Lines: see BOND_QUEST_LINES.md, Panam P2

### P3. Nomad Driving School (`panam-driving-school`)

Gate: bond 5, `sq004_riders_on_the_storm` finished, none of her quests active. Any relationship.

Premise: she has watched V drive and has opinions. Nomads learn on dirt, so she sets V a route through the Badlands the clan's kids run, rides
shotgun and grades V. Then she drives it herself to show how it is done.

Stages:
1. `dare`: **talk**. She bets V cannot run the kids' route under her time. Tags: V takes the bet (`bet`, optionally with eddies on it), V passes
   (`pass` -> ending `chicken`).
2. `run`: **ride with checkpoints and a time limit**. V drives with her in the passenger seat through five `place` checkpoints in order: the dry
   riverbed below Rocky Ridge, the wind turbines near Biotechnica Flats, a dirt ramp off the canyon road, the old rail bridge, and back to the
   Sunset Motel. Limit 6 game minutes (tunable by the car class V uses). Her `remote`-style remarks at each checkpoint come from her real seat
   (spoken by her copy in the car). Leaving the route, or arriving late, is not a failure: the time is the grade.
3. `her-turn`: **chauffeur on her own route**. She takes the wheel of the Mackinaw (`her-car` + `chauffeur` with a fixed route of the same checkpoints)
   and shows V the line. V rides.
4. `grade`: **talk**. She grades V in her mock-formal review voice.

Talk:
* specific, practical driving notes (braking before the dip, not in it), never a lecture
* the kids' route as family tradition: who set the record, how she learned it
* when V beats her time: delighted and furious at once
* the bet paid both ways

Outcomes:
* `ace` (V under the time, +50): "V beat the kids' route in the Badlands under your time, and you made them swear not to tell Mitch." Reward:
  the bet (`eddies`) and her old driving gloves (`items`, a cosmetic glove item if the game has a fitting one, else none).
* `pass-grade` (V finished, slower, +40): "You taught V the kids' route through the Badlands. They are not bad, for a city driver."
* `crash-out` (V gave up or wrecked the car, +25): she laughs about it for weeks.
* `chicken` (+5).
* `history`: she names V's time as "the city record".

Images:
* `driving-school-dust.png`, sent at the end: the Mackinaw airborne off a dirt ramp at sunset, a wake of dust, wind turbines on the horizon,
  game-look photo mode, slightly tilted like it was shot from a following car.

Build: `ride` with ordered checkpoints and a game-time grade (new), `chauffeur` on a route (existing drive-to-point chained over the route's
points: small addition), `her-car`, `eddies` bet (existing flows), `items` (unverified).

Lines: see BOND_QUEST_LINES.md, Panam P3

### P4. Ghost on the Wire (`panam-relay-ghost`)

Gate: bond 6, `sq027_01_basilisk_convoy` (With a Little Help from My Friends) finished, none of her quests active. Any relationship.

Premise: someone is listening to the family's radio. Carol traced it to a relay mast on the ridge above Vasquez Pass that Raffen Shiv took over:
they hear every run the Aldecaldos plan. Panam wants to turn it around, not blow it up: plant Carol's device on the relay so the Raffen hear
whatever the family wants them to hear. That only works if nobody knows anyone was there.

Stages:
1. `brief`: **talk**. Carol's device, the plan, why quiet matters. Panam, half to herself, brings up the childhood friend the Raffen took and how
   Cassidy got her back. Tags: V is in (`in`), V wants to just shoot the place up (`loud` -> she refuses: "then you go alone and it's useless"),
   V refuses (`no` -> `nobody`).
2. `approach`: **post + escort on foot**. They drive to the foot of the ridge. She takes a `post` at the truck as the getaway driver, engine off,
   lights off. V climbs alone.
3. `plant`: **stealth**. At the relay `place`, a `squad` of 5 Raffen (relaxed, patrolling two spots, one netrunner at the mast's hut). V must reach
   the hut's console (an inner `place` of 3 m) and stay 10 s (the "plant") while `unseen`. Her `remote` lines on V's radio count the patrol.
   Branches:
   * reached and planted unseen -> `planted`
   * spotted (combat starts, `unseen` fails): the squad turns hostile, the device is useless, V fights out or runs. She brings the truck up
     the hill (her `chauffeur` to a `place` near the mast) to pull V out -> `burned`
   * V takes the guards out silently (non-lethal takedowns or kills without any alert): still `unseen`, -> `planted` with `quiet-hands`
4. `exfil`: **ride**, she drives V off with the lights off. Closing beat.

Talk:
* her specific instructions, short, under breath
* the childhood friend: the first time she says it, she stops herself
* after `planted`: almost giddy at the thought of the Raffen chasing ghosts
* after `burned`: she does not blame V, she blames herself for the plan, which is the anxiety the profile names

Outcomes:
* `planted` (+65): "You and V turned the Raffen's own relay against them. They hear only what the family wants them to hear." Lasting: in later
  talk she now and then says what lie the family fed them this week (a `history` line plus a small list of rotating jokes in the pack).
* `burned` (+40): "V was spotted at the Raffen relay and you pulled them out. The plan failed, and you think it was yours that was wrong."
* `nobody` (-5).
* Reward: Carol pays 2,500 eddies for `planted` (`eddies` gift).

Images:
* `relay-ghost-mast.png`, sent by Carol's line through Panam at the end: a rusted radio mast on a ridge at night, a small blinking device taped to
  its junction box, the lights of a far Raffen camp below, game-look photo mode, cold blue moonlight.

Build: `post` (getaway), `squad` (patrol: needs two patrol points in the squad record, new), `unseen` (new: V's combat state and the squad's alert
state), `place` with an inner radius and a dwell time, `remote`, `chauffeur` to a place, `ride`.

Lines: see BOND_QUEST_LINES.md, Panam P4

### P5. The Long Way Home (`panam-convoy-home`)

Gate: bond 8, `sq027_02_raffen_shiv_attack` (Queen of the Highway) finished, none of her quests active. Any relationship.

Premise: Saul has asked Panam, not anyone else, to lead a small supply run: two clan cars of medicine and parts from a contact at the SoCal border
crossing back to camp. It is the first time he trusts her with the family's people, and she is terrified of it in a way she will only show V.

Stages:
1. `ask`: **talk**. She asks V to ride with her, "not as a gun, as a friend". Tags: `yes`, `no` -> ending `she-went`.
2. `pickup`: **meet at a place**. V meets her at the border crossing `place`. Two Aldecaldo `cast` drivers (nameless nomad extras with their own
   cars) wait. V rides in the Mackinaw (`her-car`, she drives).
3. `run`: **convoy with interception**. The `convoy` (the Mackinaw leading, two clan cars behind) drives three legs toward camp. On the second leg a
   `squad` of Raffen in two cars waits at the narrow canyon road (`place`). She stops the column short of it (the convoy stops at the leg end) and
   asks V for a call: go around the long way (adds a leg through the salt flats, no fight) or punch through (combat, V and she fight, the
   extras stay in their cars).
   Fail: a clan car is destroyed (the `convoy` reports it) -> `lost-one`.
4. `camp`: **arrival**. The column reaches the Aldecaldo camp `place`. Saul is game-placed and only talks (if V speaks to him). Panam's copy stands
   with V by the trucks.

Talk:
* before: her dread, Saul's trust as a gift and a test, the clan's eyes on her
* at the choice: she genuinely wants V's opinion and will follow it, which costs her
* after: what Saul said, or did not say, and how she reads his tense face as thanks (her own canon habit)
* (`lost-one`) she does not cry in front of the clan. She does with V, briefly, later.

Outcomes:
* `delivered` (+80): "You led the clan's supply run from the border with V beside you, and every car came home." Reward: Saul's gift through her,
  the clan's thanks in eddies (3,000) and a standing line in her talk: the family calls V by a nickname she picks.
* `delivered` by the long way, no fight (+85): she notes that V chose people over pride.
* `lost-one` (+45): "You led the supply run and lost a car on the canyon road. V was there." She is quieter about the clan for a while (a 7-day
  note).
* `she-went` (+0): she went alone and it went fine, and she is a little hurt V was not there.
* `memory-share`: Mitch's and Saul's copies know (talk only for game-placed ones).

Images:
* `convoy-home-column.png`, sent at `camp`: three dusty nomad vehicles in a line on a desert road at golden hour, the Mackinaw in front, a long
  shadow column, camp lights far ahead, game-look photo mode, wide shot from a low angle.
* `convoy-home-camp.png`, sent the next game day: Panam asleep against the Mackinaw's wheel at the camp, a blanket over her knees, morning, taken
  by someone else (Mitch, by the caption).

Build: `meet` at a `place`, `cast` (nomad extras), `convoy` (new, the riskiest: three spawned cars driving in a column, see section 15), `squad` with
vehicles (the ambush squad already rides out of cars in the game's retaliation chases, unverified for ours), a choice that reroutes the convoy
(a second route in the data), `her-car` driven by her.

Pins: the meeting point, the border crossing where the column forms.

Lines: see BOND_QUEST_LINES.md, Panam P5

### P6. Nowhere in Particular (`panam-nowhere`)

Gate: bond 10, `sq027_02_raffen_shiv_attack` finished, none of her quests active, and P5 finished (`after`). Two variants by relationship (partner
or not).

Premise: Panam has never once driven anywhere without a reason. She asks V to take her out of the city at night with no destination, no job, no
clan, and to pick the music. On the drive she says what she has never said to anyone: what she is afraid she will turn into if she leads the family,
and what she is afraid she will lose if she does not. At dawn she gives V something that is hers.

Stages:
1. `ask`: **call-in or text**. She asks V to come get her at the camp (`meet` at the camp `place`). "Your car. Your music. No questions where."
2. `drive`: **aimless night drive**, `ride` with no destination, `together` in the car for 60 game minutes outside Night City's districts
   (the `district` reads: Badlands or Dogtown edges count, the city does not), and a `radio` check: she asks V to put something on, and her next
   line reacts to the station and song V picked (the song's name is in the turn). Stopping too long, or driving back into the city, gently ends
   it early (`short`).
3. `dawn`: **sit at an overlook**. V stops anywhere with a view. She gets out (`party`). V sits on the ground or the hood (`seat` on a ground
   workspot, `together` seated, 10 game minutes). The confession beat.
4. `keepsake`: **gift**. She gives V her mother's Aldecaldo bracelet (or, if the game has no fitting item, the words and an `image` of it, kept in
   V's chat thread), and, as partner, asks V something about the future she has never asked anyone.

Talk:
* the drive: no planning, which is unnerving for her, then a relief she laughs at
* the music: she reacts to what V really picked, teasing or moved
* the confession: leadership and losing herself, Saul's choices she understands better than she admits, and that V is the one person she
  can say it to
* partner variant: the future, said plainly, no pet names (her intimacy is "earned and specific")
* friend variant: "family" said as a fact, not a favour

Outcomes:
* `dawn` (+100): partner: "One night V drove you nowhere, you told them what scares you about leading the family, and at dawn you gave them your
  mother's bracelet." Friend: the same with "you told V they are family". `history`: the bracelet, permanent.
* `short` (+50): "V took you for a drive with no destination. It ended sooner than you hoped."
* Reward: `items` (the bracelet, a jewellery-slot cosmetic if one fits, else the image only). A lasting line: from now on she refers to the
  drive when things are bad ("I'd take another nowhere").

Images:
* `nowhere-dashboard.png`, sent during the drive: a car's dashboard at night, the radio's glow, Panam's boots on the dash, desert dark through
  the windshield, game-look photo mode, warm and grainy.
* `nowhere-dawn.png`, sent after: two figures sitting on a rock outcrop above the Badlands at first light, seen from behind, one leaning on the
  other (partner) or shoulder to shoulder (friend). Two versions shipped.
* `nowhere-bracelet.png`: a worn leather and copper Aldecaldo bracelet in an open palm, morning light.

Build: `call-in` or `text`, `meet` at a `place`, `ride` without destination + `together` in a car + `district` (new combination, small), `radio`
`check` (existing song events), `seat` on a ground workspot (`workspot`, new), `items` (unverified), `image` with variants.

Pins: the meeting point, the Aldecaldo camp where she asks to be picked up.

Lines: see BOND_QUEST_LINES.md, Panam P6

### Panam: scripted lines, holocalls and talk gaps

The scripted lines, the holocall scripts and the talk gaps (and the music and sound notes) of P1 to P6 are in [BOND_QUEST_LINES.md](BOND_QUEST_LINES.md), under Panam Palmer, quest by quest.

### Panam reaches out first

| Trigger | Channel | Opening line(s) | Cooldown | The LLM knows when V answers |
|---|---|---|---|---|
| `sq004` Riders on the Storm finished (next game morning) | text | "Saul's walking. Complaining, but walking. Thanks for that." | once | Saul was rescued from the Raffen with V's help, she is relieved and won't gush |
| `sq027_02` Queen of the Highway finished | text | "Still smell like the Basilisk. Can't stop grinning." / partner: "Still thinking about the Basilisk. Mostly the second part." | once | the Basilisk raid is done, her mood is high, the romance state from the save |
| bond level 5 reached | text | "Mitch says I mention you too much. Mitch should mind his business." | once | bond rose, nothing else changed |
| bond level 7 reached | holocall | "Nothing's wrong. I just wanted to hear someone who isn't family. That's a compliment, by the way." | once | she has no agenda, she wants talk, she may bring up a hangout |
| bond level 9 reached | holocall | "If you ever need to disappear, there's a place out here nobody knows. I'm telling you because it's you." | once | the hideout is a place in the Badlands she will not name on the phone |
| a dust storm in the Badlands while V is there (weather `check`, verify the read) | text | "Storm's coming your way. Get inside or get to the camp. Don't be stupid about it." | 3 game days | the weather, V's district |
| V reached a heat of 4 or 5 in the city | text | "Saw the news. Is that you? Of course that's you. Breathe, then call me." | 2 game days | V's wanted level was high, she saw it on a feed |
| 23:00 to 02:00 game time, V idle at home, bond 6+ | text | "Can't sleep. Talk me down from driving to the city at two in the morning." | 4 game days | she is restless, nothing is wrong, she may suggest a hangout |

### Panam hangouts

Repeatable, free time between quests, each at its own place (the hangout registry, section 16). Bond: +6 for accepting and meeting her, plus the
activity's own amount. One hangout a game day per character, each hangout at most every 3 game days.

**PH1. Fixing the Mackinaw** (unlock bond 3). *Place:* the garage of the gas station at Jackson Plains (verify the garage interior). *Invitation:*
"Truck's making a noise. Come hand me things and pretend you know what they are." *Activity:* she works under the truck (`workspot`, a mechanic's
"under the car" workspot, verify, fallback a crouch idle), and asks V for parts by name: V finds three marked crates in the garage (`place` inner
spots, 2 m each) in the order she calls them. Right order +6, any order +3. *Twist (one of three per visit):* the part is in V's own car's trunk (V
must bring the car in), a stray dog wanders in and she names it, or the noise was a beer bottle rolling in the cab. *Gap:* while
under the truck she asks "What was the first car you ever drove?" (knows: the repair, the parts list. idle: the mechanic workspot. resumes: V brings
the next part. flavour: she remembers V's answer for later teasing). *Variations:* the noise changes each visit (brakes, belt, the radio). *Image:*
none. *Build:* `meet`, `workspot`, `place` inner spots in order, `cast` (the dog, a nameless animal extra if the record exists, verify).

**PH2. Billboard Beers** (unlock bond 4). *Place:* the top of an old billboard over the highway north of Biotechnica Flats (verify one with a
climbable frame). *Invitation:* "I'm sitting on a billboard with two beers. One's getting warm. Figure out how to get up here." *Activity:* she
is already on top when V arrives (the visitor copy placed at the top, out of V's sight), and V has to find the way up (the climb is the puzzle:
`place` arrived at the top, timed). Her lines from above heckle V's route. Up in under 3 game minutes +8, slower +4. Then they sit on the edge
(`seat` on a ledge `workspot`, verify) and play "name the car" from the headlights below: she calls a make, V guesses its owner's story (talk).
*Twist (one per visit):* she dropped the bottle opener and V must fetch it from the bottom, a Wraith bike stops under the billboard and they
both go very quiet, or a storm rolls in and the beers are finished fast. *Gap:* "What's the stupidest thing you ever climbed?" (knows: V's climb
time. resumes: the next car's headlights, a 2-game-minute timer). *Variations:* dusk, night with headlights, a dust storm. *Image:* none.
*Build:* `meet` (visitor placed at a fixed spot), `place` with a timer, `seat` on a ledge `workspot`, `together`.

**PH3. Stargazing at the Turbines** (unlock bond 5). *Place:* the base of the wind turbines south of the Kendachi farm road (verify the name).
*Invitation:* "Clear sky tonight. I know where the turbines hum. Bring a jacket." *Activity:* lie on the ground (`workspot`, a lie-on-back
workspot, verify) for 10 game minutes. She names constellations wrong on purpose and waits for V to correct her: V's corrections are free talk, and
three exchanges give +6. *Twist:* a satellite flare, a shooting star she makes V wish on, or an AV passing low that makes her go quiet (Hellman
memories, if Ghost Town). *Gap:* "If you could leave the planet, would you?" *Variations:* time of night, a meteor shower variant. *Image:* one,
`turbines-sky.png`, two figures lying in grass under turbines at night, a long exposure of stars. *Build:* `meet`, `workspot`, `together`, `image`.

**PH4. Diner Rules** (unlock bond 6). *Place:* the roadside diner at the Old Turbine Farm road junction (verify which Badlands diner has an
interior). *Invitation:* "I'm hungry and I'm buying. That's not a joke, I'm actually buying." *Activity:* sit at the counter (`seat` stool),
she orders for both of them and V must guess what she ordered from her description (free talk, one guess). The twist decides the meal. +6.
*Twist:* the cook knows her from childhood and tells V a story she hates (a `cast` extra line), or the jukebox only plays one song, or a Raffen kid
comes in and she pays for his food without a word. *Gap:* "Tell me something you're bad at. I've told you plenty." *Variations:* breakfast,
midnight, a storm keeps them in. *Build:* `meet`, `seat`, `cast` (the cook), `together`.

**PH5. Dust Run** (unlock bond 8). *Place:* the dry lakebed east of Laguna Bend's dam road (verify, and kept away from Judy's hill). *Invitation:*
"Bikes. Lakebed. Loser buys fuel." *Activity:* a short sprint of two of V's bikes or cars side by side, her in her truck (`race`, one straight
leg, no checkpoints, distinct from P3's route). Win +8, lose +5. *Twist:* she cheats with a head start and admits it, or her truck stalls and V must
decide to wait (V waiting gives +8 and a better line), or a dust devil crosses the course. *Gap:* at the finish, "Again, or are you done
embarrassing me?" (resumes on V's answer). *Variations:* dawn, dusk, night with headlights. *Build:* `meet`, `race` (single leg), `her-car`.

### Panam's gifts

What V can give her, and her one-line reaction per tier (items in section 17's tables):

| Tier | What | Her reaction line |
|---|---|---|
| loved | car parts and tools, a good rifle scope, Aldecaldo or nomad clothing, real food (not synth) | "Where did you find this? No, don't tell me, let me enjoy it." |
| liked | beer, a bottle of tequila, ammunition for her rifle, a road map or a shard of old Badlands photos | "That works. Thanks, V." |
| disliked | corporate clothing, anything Biotechnica or Militech branded, synth food | "Is this a joke? Tell me it's a joke." |

Her own gifts to V, the line by tier: common "Found this in the truck. It's yours now, I'm not cleaning it." · uncommon "Spare. Don't make a
thing of it." · rare "Mitch made this. Don't lose it, he'll know." · epic "This was going to the clan. I'd rather it went to you." · legendary
"This is mine. I mean, it was. Now it's yours."

---

## 5. Judy Alvarez

Canon anchors: braindance editor in Lizzie's basement, allied with the Mox, a techie raised by her grandparents in Laguna Bend (her grandfather
taught her the craft, the town was flooded, her grandparents left for Oregon). Evelyn's death, Maiko's betrayal of what Judy thought they had,
the dolls of the Clouds, her hatred of anyone who treats people as disposable. Dry jokes, flattery-proof, practical reassurance. Her van is
`her-car`. The existing pack "Dressed for Dinner" covers a dress and a dinner at Lizzie's, so no quest here is a dinner or a dress, and none is a
dive (Pyramid Song). Ladder: 3, 4, 5, 6, 8, 10.

### J1. Spare Parts (`judy-spare-parts`)

Gate: bond 3, `q105_04_judys` finished (the end of her main-story part), no `q105`, `sq026` or `sq030` quest active. Any relationship. Eddies on.

Premise: a BD rig of hers fried a matrix and the parts she needs are not sold anywhere respectable. She asks V to come to Kabuki Market with her
because the stall owner who has them "likes mercs better than editors". A casual afternoon of walking, haggling and her running commentary on junk.

Stages:
1. `ask`: **talk**. `meet` at the Kabuki Market `place` (the market's central stairs) within 3 game hours.
2. `stalls`: **walk / hangout**, `party` + `together` (6 m, 20 game minutes, at the market `place` radius). She stops at stalls and turns junk into
   grand treasure stories, then punctures them (her canon habit). Her `gestures` point at things.
3. `haggle`: **talk with a vendor extra**. A `cast` stall owner (a nameless Kabuki trader extra, talkable as an ordinary NPC) has the matrix. V
   talks the price down (his reaction is the bridge's ordinary NPC decision) or pays it (`eddies` to an NPC, the same small flow as P2), or
   V says Judy can pay (she does, grumbling, `eddies` stays hers).
4. `hand-over`: **give**. She asks V to carry the box (narrative), and at the end of the walk gives V a little thank-you she made: a modded
   holo-keychain (`items`, a cosmetic or junk item renamed in the image only, see build).

Talk:
* treasure-story riffs on junk, and practical asides on what each part really does
* small personal details (level 3): her grandfather's hands, why she still prefers factory casings
* during the haggle: her quiet commentary on V's technique

Outcomes:
* `bargain` (+40): "V haggled the stall owner at Kabuki Market down for your matrix. You have not stopped telling people."
* `paid` (+35), `judy-paid` (+30, she teases V for being cheap, affectionately).
* `stood-up` (-5).
* Reward: the keychain `image` and, where an item fits, `items`.

Images:
* `spare-parts-market.png`, sent after: a crowded Kabuki Market stall at dusk, neon kanji signs, a table of tangled cables and old BD wreaths, a
  hand holding up a cracked matrix to the light, game-look photo mode.

Build: `meet` at a `place`, `party` + `together` (new), `cast` (new: a talkable trader extra), the "pay an NPC" `eddies` flow (new, small),
`items` (unverified), `image`.

Pins: the meeting point, the central stairs of Kabuki Market.

Lines: see BOND_QUEST_LINES.md, Judy J1

### J2. Door Duty (`judy-door-duty`)

Gate: bond 4, `sq026_01_suicide` (Both Sides, Now) finished, none of her quests active. Any relationship.

Premise: the Mox who works Lizzie's door got hurt and Susie Q asked Judy to cover the night shift. Judy is no bouncer and knows it. She asks V
to stand the door with her for an hour, because "you're scarier than me and I'm meaner than you".

Stages:
1. `ask`: **talk**. `meet` at Lizzie's Bar `place` (the front door on the street) in 2 game hours, night.
2. `shift`: **timed presence with incidents**, `together` at the door `place` (V within 8 m of the door, 60 game minutes). Her copy holds a
   `post` at the door (leaning on the wall, `workspot`). Three incidents arrive as `cast` extras walking up at set minutes:
   * a drunk corpo who will not take no for an answer (the ordinary NPC rules decide: talked away -> `npc-react` leave, insulted -> brawl)
   * a Tyger Claw scout photographing the bar (talk him off, or the threats route: cower or attack)
   * a scared young doll from the Clouds asking for Judy by name (no fight: V and Judy's words decide if she comes in, which Judy wants)
   Each incident ends by the NPC's reaction (left, cowered, brawled, came in). A fight at the door does not fail the shift.
3. `close`: **sit together** inside after the shift (`seat` at the bar, `together` seated 10 game minutes). She buys V a drink.

Talk:
* her own nerves under the jokes, and how strange it is to protect the place that protects her
* the doll: what the Mox are for, said with feeling, and what she owes Evelyn
* level 4 opinions: on Susie Q's management, on the Mox's limits (whom the gang can help)

Outcomes:
* `quiet-door` (no brawl, the doll came in, +55): "You and V worked Lizzie's door one night, and the girl from the Clouds came in safe."
* `rough-night` (one or more brawls, +45): she loves a story and tells it with more blood each time.
* `doll-turned-away` (V sent the girl off, +15): she is short with V for a while (a 3-day note), and she says why.
* `left-early` (V left before the hour, +5).
* `memory-share`: Susie Q (game-placed, talk only) knows V covered the door.

Images:
* `door-duty-neon.png`, sent after: the doorway of Lizzie's Bar at night, pink neon on wet pavement, Judy leaning in the doorframe arms crossed,
  a figure (V) beside her, shot from across the street, game-look photo mode.

Build: `meet`, `together` at a `place` (new), `post` + `workspot` (new), `cast` with timed arrivals (new), `npc-react` on the extras (existing for
ordinary NPCs, needs the extras to count as ordinary), `seat` (existing).

Pins: the meeting point, the front door of Lizzie's Bar.

Lines: see BOND_QUEST_LINES.md, Judy J2

### J3. Stolen Signal (`judy-stolen-signal`)

Gate: bond 5, `sq026_02_maiko` (Ex-Factor) finished, none of her quests active. Any relationship.

Premise: someone broke into the Mox's BD storeroom and took a case of raw recordings: dolls' testimonies Judy was editing for the Mox, the kind
that could get the women in them killed if the wrong people watch. Judy traced the thief's buyer meeting: a courier on a bike is taking the case
across Watson right now.

Stages:
1. `alarm`: **talk + call**. It starts on a holocall or a text with urgency (the shortest timer in the document: 30 game minutes). She sends V the
   courier's last position (a `place` on the Kabuki roundabout).
2. `chase`: **chase**, a `runner` (a courier bike, a nameless extra rider) drives a fixed route from Kabuki through Little China toward Northside.
   V chases in any vehicle. Judy rides with V if she is in the party (`party` passenger, her lines from the seat), else on the holocall (`remote`).
   * V gets within 10 m and the bike stops (V rams it, shoots the tyres, or the bike's damage stops it): the rider runs on foot, `npc-react`
     decides if he gives up the case (threats) or fights -> `caught`
   * the bike reaches the route's end (a Northside warehouse `place`): -> `buyer`
3. `buyer` (branch): **combat at a place**. The case is already being handed to a `squad` of 3 scav buyers (the people who would sell the women's
   identities). V fights. Down: `recovered`. V leaves: `lost`.
4. `burn`: **talk**. Back at Lizzie's (`meet`), Judy decides what to do with the recordings: V's opinion matters. Tags: `keep` (she finishes the
   edit), `burn` (she destroys them and tells the women).

Talk:
* urgency in short sentences, then afterwards the shakes she covers with a gross joke
* what the testimonies are, why she made them, what Evelyn would have said
* the keep-or-burn question as a real moral weight, not a quiz

Outcomes:
* `caught` + `keep` or `burn` (+60): "V chased down the courier who stole the dolls' testimonies across Watson." The choice is remembered in later
  talk ("the testimonies" come up again in J5).
* `recovered` (+50): the same with "they had already reached the scavs".
* `lost` (-10): "The dolls' testimonies were sold to scavs. V tried." She warns the women. J5's premise reads this (see J5).
* Reward: none in eddies (she has none to spare). Her respect, said plainly.

Images:
* `stolen-signal-case.png`, sent after: a battered hard case open on a workbench in Lizzie's basement, rows of BD chips in foam, a hand-written
  label "DO NOT EDIT - J", lamp light, game-look photo mode.

Build: `runner` (new: a spawned bike on a fixed route with the invitation car's drive-to-point command), `party` or `remote`, `npc-react` on the
runner's rider, `squad`, `meet`. The runner is the second-riskiest primitive (section 15).

Lines: see BOND_QUEST_LINES.md, Judy J3

### J4. The Claws Come Calling (`judy-claws-calling`)

Gate: bond 6, `sq026_04_hiromi` (Pisces) finished, none of her quests active. Any relationship.

Premise: whatever V chose in Pisces, the Tyger Claws came out of it holding a grudge against the Mox. Tonight they send a message: a crew rolls up
on Lizzie's to wreck the place. Judy is not a fighter, and she is not leaving her workshop. She calls V.

Stages:
1. `call`: **call-in or text**. "They're coming. Tonight. Please." `meet` at Lizzie's within
   1 game hour. Not there in time: the bar takes the hit without V (`late`).
2. `hold`: **defend a place in waves**. At Lizzie's street front (`place`), three waves of Tyger Claws: 3 on foot, then 3 from a car, then 2 with a
   heavier fighter (the squad spawner's "never a heavy" rule relaxed for this pack, with a record check). Judy holds a `post` inside the door with
   a pistol (`fight` from the post). Mox extras (`cast`, 2) fight beside V. Success: all waves down. Fail: V more than 120 m away while a wave
   stands, or the door breached for 30 s (a Claw inside the door `place` radius with no fight near): `wrecked`.
3. `after`: **walk / aftermath**. V walks the street with her looking at the damage (`together`, 10 game minutes). The workshop is fine.
4. `fix`: closing beat, an `image` the next day.

Talk:
* fear, said straight, for once without a joke
* anger at the Claws and, under it, at Maiko (whatever Pisces did to her), as the profile allows
* afterwards: a very practical list of what needs fixing, then gratitude she is bad at saying

Outcomes:
* `held` (+70): "The Tyger Claws came for Lizzie's after Pisces, and V held the street with you." Reward: the Mox give V free drinks for life at
  Lizzie's (a `history` line that the Mox characters use in talk), and 2,000 eddies from Susie Q (`eddies` gift through Judy).
* `wrecked` (+40): "The Claws wrecked the front of Lizzie's even with V there. Nobody died."
* `late` (-15): "The Claws hit Lizzie's. V didn't make it." She is fine, and she says so too often.

Images:
* `claws-calling-aftermath.png`, sent the next morning: the front of Lizzie's Bar at dawn with boarded windows and spray paint, a Mox repainting
  the sign, Judy sitting on the step with a coffee, game-look photo mode.

Build: `call-in` (new) or `text`, `meet`, `squad` with waves and a car wave (new), `post` + `fight` from it, `cast` allies (new, friendly
extras that fight: they are the game's Mox records, spawned friendly), `together`, `image`.

Pins: the meeting point, Lizzie's Bar.

Lines: see BOND_QUEST_LINES.md, Judy J4

### J5. No More Dolls (`judy-no-more-dolls`)

Gate: bond 8, `sq026_04_hiromi` finished and J3 finished (`after`), none of her quests active. Any relationship.

Premise: a scav crew is making XBDs again in Watson, the same trade that took Evelyn to the power plant. They have taken a girl: Rina, a Mox
runaway Judy helped out of the Clouds (if J3 ended `lost`, they found Rina through the stolen testimonies, and Judy blames herself). This one is
not a job. Judy is coming in herself, and she is scared of what she will see.

Stages:
1. `found`: **talk**. Judy has the place: a scav den in a dead parking garage in Northside. Tags: `together` (she comes with V), `alone` (V tells
   her to stay: she argues, then takes a `post` in her van as the lookout, on `remote`).
2. `in`: **stealth or combat, V's choice**. At the den `place`, a `squad` of 6 scavs (relaxed on two floors, one netrunner) and a `hostage`
   (Rina, a nameless young woman extra in the BD chair, a "restrained" workspot). V can go `unseen` to the chair, or fight.
   * The scavs' rule: once combat starts, after 45 s one goes for the hostage. If the hostage dies -> `too-late`.
3. `chair`: **rescue**. V reaches the hostage (within 2 m, 5 s). She follows V out (`hostage` becomes a temporary follower like a recruit).
   Judy, if with V, tears the rig out of the chair (her `workspot` at the rig, a few seconds), then stops in front of the screens.
4. `out`: **escort on foot to the van** (`place`), squad remnants chasing. Then `ride`: V or Judy drives Rina to Lizzie's.
5. `after`: **sit together** at Judy's (`meet` home or at Lizzie's basement, `seat`, 20 game minutes). The most open she has been: Evelyn, the
   power plant, why she never stopped feeling responsible.

Talk:
* before: almost nothing, short, focused
* at the screens: she says what she sees, then refuses to look anymore (never a description of the XBD content: she reacts, she does not narrate)
* after: Evelyn, guilt, the dolls, and the fact that V came, which she does not know how to thank

Outcomes:
* `saved` (+90): "You and V got Rina out of a scav XBD den in Northside. You tore the rig out yourself." Lasting: the J3 choice and this one are
  linked in her talk. Partner variant adds a beat of physical comfort she asks for. Reward: none she can give, she says, so she gives V the one
  thing she has: the master key to her workshop (an `image` and a `history` line: V can always come down).
* `saved-unseen` (+95): V went in so quietly nobody fired a shot. She is in awe of it.
* `too-late` (+30): "Rina died in the scav den before you and V reached her." She needs V for a week of game days (a 7-day note: she texts more).
* `memory-share`: Susie Q and the Mox characters know V got Rina out.

Images:
* `no-more-dolls-van.png`, sent the next day: the inside of Judy's van at night, a girl wrapped in a Mox jacket asleep on the bench seat, Judy's
  hand on the wheel, rain on the windshield, game-look photo mode.
* `no-more-dolls-key.png`: an old brass key on a cord with a tiny pink plastic charm, on a workbench next to a BD wreath.

Build: `squad` on two floors (spawn points per floor), `hostage` (new), `unseen` (new), `workspot` (the restrained captive and her at the rig, new
workspots or "hard" if no restrained pose exists: then the captive kneels with the cower reaction, see section 15), `post` in her van + `remote`,
escort on foot (`party` + the hostage following + `place`), `ride`, `seat`.

Lines: see BOND_QUEST_LINES.md, Judy J5

### J6. Grandpa's Recording (`judy-grandpa-recording`)

Gate: bond 10, `sq030_judy_romance` (Pyramid Song) finished, J5 finished (`after`), none of her quests active. Two variants (partner or not).

Premise: her grandfather sent her a package from Oregon: an ancient BD recorder he built, and on it a raw recording he made of Laguna Bend the
week before the flood, which he never showed anyone. Judy edited it into a braindance for exactly one other person, V. Then she wants V to stand
with her where it was recorded, which is now the lakeshore.

Stages:
1. `gift`: **talk + text**. She asks V to come to her place (`meet` home or her flat). "Bring nothing. Sit down."
2. `bd`: **braindance-style scene**. V "wears" the wreath (V sits, `seat`), and the BD plays as a sequence of four prepared `image`s in the chat
   thread while her copy talks V through it beat by beat (her stage notes per image: the street, Flo's Diner, the church square full of people, the
   last image of her grandfather's hands). V's words between images are her cues: she answers about what V sees.
3. `drive`: **road trip in her van**. She drives V out to Laguna Bend in her van (`her-car` + `chauffeur`), the way she drove in Pyramid Song, but
   this time talking about her grandparents, not her ghosts.
4. `frame`: **a photo moment, the same frame fifty years later**. She walks V up the hill above the reservoir (`party` to a `place` of 15 m)
   and stands V exactly where her grandfather stood. V takes the shot with the game's own photo mode if V wants (the mod can see that photo mode is open, never
   what V shot, and does not need to): what counts is V standing on the spot for 30 s while she lines it up with the last BD frame (`place` dwell). Then she
   asks V to take one more, of the two of them. Dwell done: `frame`. V walks off before it: `rushed`.
5. `stay`: **sit together at the view** (`seat` on a ground `workspot`, `together` 15 game minutes) while the sun sets over the water where the
   town was.

Talk:
* the BD: specific sensory detail, her editor's notes, the reasons for every cut, and none of it a lecture
* her grandfather: his stories, his hands, the church acoustics she tested as a kid
* partner variant: whether V would ever come to Oregon with her to meet them, said as a real question
* friend variant: she tells V that she has never let anyone into her head before, and that the craft means something because of people like V

Outcomes:
* `frame` (+100): "You made a BD of your grandfather's last recording of Laguna Bend for V, and you stood V where he stood to take the same
  frame fifty years later." `history`: permanent, she calls it "our hill".
* `rushed` (+85): the same, though V did not wait for the shot, and she teases V about it.
* Reward: the recorder itself, if V asks for it and she agrees (`items`, a junk-slot item renamed only in the image), and the BD's final image kept in
  the chat thread for good.

Images (the most images of any quest, all from the grandfather's point of view, slightly soft and over-saturated like old BD footage):
* `grandpa-bd-street.png`: a small-town main street in the 2050s, low houses, a water tower, kids on rollerblades with a hockey stick.
* `grandpa-bd-diner.png`: the inside of Flo's Diner, a huge greasy burger in front of a little girl with green-dyed hair tips (Judy as a child,
  seen from behind).
* `grandpa-bd-church.png`: a church square full of people listening to a notice being read, worried faces.
* `grandpa-bd-hands.png`: an old man's hands soldering a circuit board on a kitchen table, a child's hands holding the board steady.
* `grandpa-bd-hill.png`: the view from a hill over the town and a river valley, sunset, the frame she recreates with V.
* `grandpa-bd-now.png`, sent at `stay`: the same hill today, the lake over the town, the church roof just under the water, two people sitting.

Build: `meet`, `seat`, `image` sequence with per-image stage notes (new: a stage that advances on V's turns), `her-car` + `chauffeur` (existing),
`place` with a dwell time, `workspot` (new), `items` (unverified).

Pins: the meeting point, Judy's flat.

Lines: see BOND_QUEST_LINES.md, Judy J6

### Judy: scripted lines, holocalls and talk gaps

The scripted lines, the holocall scripts and the talk gaps (and the music and sound notes) of J1 to J6 are in [BOND_QUEST_LINES.md](BOND_QUEST_LINES.md), under Judy Alvarez, quest by quest.

### Judy reaches out first

| Trigger | Channel | Opening line(s) | Cooldown | The LLM knows when V answers |
|---|---|---|---|---|
| `sq026_01` Both Sides, Now finished (two game days later) | text | "Still can't sleep in that apartment. Don't come over. Just text me something dumb." | once | Evelyn's death, she is grieving and wants distraction, not comfort |
| `sq030` Pyramid Song finished | text | partner: "Still have lake water in my ear. Worth it." friend: "Thanks for diving with me. Means more than I said." | once | the dive, the romance state from the save |
| bond level 5 reached | text | "Fixed my wreath. Made it play your voice when it boots. Kidding. Unless?" | once | the bond rose, she is teasing |
| bond level 7 reached | holocall | "I'm editing and it's four in the morning and I just wanted a face. Yours, specifically." | once | she is working late, it is a soft call |
| bond level 9 reached | text | "Grandpa asked who the person in my photos is. I said nobody. He laughed at me." | once | her grandparents know about V now |
| 03:00 to 05:00 game time, bond 6+ | text | "You up? Sensory track glitched and now I can't stop smelling rain." | 4 game days | late-night work, nothing is wrong |
| V was in a big fight in Watson (combat ended in Kabuki or Little China) | text | "Saw the smoke from Lizzie's. That you? Be alive, please." | 2 game days | combat in her area, she is worried |
| raining in Night City, V at home | text | "Rain's good for editing. Come down to the basement, bring noodles." | 3 game days | weather, an invitation that can become a hangout |

### Judy hangouts

**JH1. Roach Race** (unlock bond 3). *Place:* the arcade near the Kabuki roundabout (verify which Kabuki arcade has playable 2.x cabinets). *Invitation:* "I hold the high score on this thing. Come lose to me." *Activity:* V plays the game's
own arcade minigame (the 2.x arcade cabinets, verify the score read: if no score is readable, V's play time and her live reactions are the
activity, "hard" for score). +4 for playing, +6 if V claims a score she disputes. *Twist:* she sabotages V by talking, or the cabinet eats V's coins
and she fixes it with a screwdriver (`workspot`), or Susie Q's high score appears and they unite against it. *Gap:* "Best game you ever played as a
kid?" *Variations:* three cabinets if present. *Build:* `meet`, `check` arcade (verify), `workspot`, `together`.

**JH2. Spot the Cut** (unlock bond 4). *Place:* a public braindance parlour in Kabuki, the cheap booths by the hour (verify one with an
interior). *Invitation:* "Commercial BDs are a crime against my profession. Come watch me suffer." *Activity:* she rents two booths and describes
three cuts from the cheap BD they "watch" (her stage note holds the three), one of which an editor would never make. V names the bad cut (free
talk, the bridge reads which one by a tag). Right +6, wrong +3 and a two-minute lecture she enjoys. *Twist:* the BD turns out to be one she
edited years ago and she defends it, the parlour owner (`cast`) recognises her and asks for an autograph she refuses, or the booth's wreath is
broken and she fixes it in ten seconds (`workspot`). *Gap:* "What would you want in a BD of your own life? One moment." *Variations:* an action
BD, a romance BD, a nature BD with fake birds. *Build:* `meet`, `seat` (chair), `cast`, choice tag, `workspot`.

**JH3. Sound Hunt** (unlock bond 5). *Place:* Jig-Jig Street at night, from the north arch (verify). *Invitation:* "I need ambient tracks for a BD.
You're my walking microphone." *Activity:* a walk (`together`) where V must stand still at three spots she picks (`place` inner spots, 10 s each)
while she "records" (her `workspot`, holding a device). +6. *Twist:* someone starts a fight right at the spot (an ordinary NPC brawl), a singer
in a window, or V is asked to say one line into the mic and she keeps it. *Gap:* "What does this city sound like to you?" *Variations:* rain, a
festival night, a power cut. *Image:* `sound-hunt.png`, Judy holding a small boom mic in the neon rain, laughing. *Build:* `meet`, `together`,
`place` dwell spots, `workspot`, `image`.

**JH4. Skates at the Lake** (unlock bond 6). *Place:* the empty car park by the Laguna Bend boat ramp (kept away from J6's hill, verify). *Invitation:*
"Found my old rollerblades. They don't fit. I'm going anyway." *Activity:* street hockey without skates (she cannot skate in game): a shoot-out
with a can into a goal of two crates, V's kicks counted by her (talk, no physics read, "hard" for a real ball). Played as a timed `together` with her
laughing commentary. +6. *Twist:* she falls (a stumble gesture), she scores and celebrates absurdly, or two local kids (`cast`) ask to play.
*Gap:* "Were you a sports kid or a fighting kid?" *Variations:* dusk, rain, the kids. *Build:* `meet`, `together`, `gestures`, `cast`.

**JH5. Repair Night** (unlock bond 8). *Place:* Judy's workbench in Lizzie's basement (the J3 stage there is talk only). *Invitation:* "Bring me something
broken. I'm in a fixing mood." *Activity:* V gives her a junk item from V's inventory (`takeItem`, any junk-class item): she "repairs" it at the
workbench (`workspot` at a chair) and gives back something better (`giveItem` from a small table: a junk item of a higher tier or eddies equal to its
sell price, plus a line about what it was). +8. *Twist:* she finds something personal in it (a scripted guess from the item's name), it explodes a
little (a spark effect, verify), or she gives V her own repaired thing instead. *Gap:* "Why'd you keep this?" (V's answer is the twist).
*Variations:* any junk item, by category. *Build:* `meet`, `takeItem`, `giveItem`, `workspot`.

### Judy's gifts

| Tier | What | Her reaction line |
|---|---|---|
| loved | BD wreaths and editing gear, old tech to tinker with, diving gear, a Mox jacket, good coffee | "Okay, this is actually great. Don't watch me be happy about it." |
| liked | noodles, a bottle of beer, a cat figurine or a weird trinket, tools | "Aw. You remembered. Thanks." |
| disliked | Tyger Claw or Clouds anything, corporate fashion, synth flowers | "Is this a test? It's a test, right?" |

Her own gifts to V by tier: common "Made this from scraps. Don't say it's cute." · uncommon "Spare part, but a good one." · rare "This took me
three nights. Use it." · epic "Grandpa's. He'd want someone who uses it to have it." · legendary "I've never given anyone this. So shut up and take
it."

---

## 6. Johnny Silverhand

Canon anchors: an engram of Robert John Linder on the Relic, living in V's head from the Relic onward. A soldier who deserted ("a corporate army", disillusioned in Mexico, the
employer left unnamed as the profile says), a rockerboy, SAMURAI's frontman, chrome left arm, mirrored aviators. Rogue is his old flame and partner, Kerry his rival and old
bandmate, Alt the person he loved and failed, Nancy, Denny and Henry the band, Santiago an old partner. His 2023 attack on Arasaka Tower is his own testimony, subjective, and
his guilt and his ego sit side by side. He is dry, abrasive, funny, sometimes unexpectedly quiet, and slowly starts to respect V. His body is, for now, V's body.

Framing rules that apply to all six (decided by the lead designer):
* His copy is **a figure only V sees and hears**. Nobody else talks to him or reacts to him, no enemy targets him, he never fights, never drives, never touches or carries anything.
  He is the existing Johnny-in-your-head copy (`party` in its figure form, `mod/johnny-head.lua`). His lines come in person or through `johnny-voice` (bodiless).
* The gameplay is what **V's body does for him or with him**. A "take the wheel" beat exists only as talk and as V's own choice, never as the mod moving V.
* He cannot take or send photos. His images are one of two kinds, both prepared: **V's own shot** (a game-look photo-mode picture "from V's gallery" that he comments on) or a
  **memory frame** (an old-footage look the Relic surfaces, sepia and overexposed, a presentation flag on `image`). They arrive in a "Johnny (in your head)" thread of the Phone
  Chat row, never as if he held a phone.
* Gates: his quests need the named ones of `q101_01_firestorm`, `q108_johnny`, `sq011_concert`, `sq031_rogue` finished. They run only while he still exists in V's head (the system
  gate on the point of no return already guards that). Start: on a private turn through `own` or `johnny-voice`, never by a timer.
* Real music is "hard": no character plays or sings a song for V (no new audio). A stage can only react to what the game's own radio plays (`radio` events) or be told in talk.
* The 2023 events are his own testimony. Lines never state a death toll or an exact date, and Johnny's account stays his perspective.

Ladder: 3, 4, 5, 6, 8, 10.

### SH1. What They Say About Me (`johnny-street-poll`)

Gate: bond 3, `q101_01_firestorm` (the 2023 Arasaka Tower memory) finished, no `q101`, `q108` or `sq011` quest active. Any relationship.

Premise: after seeing his own memory of the tower, Johnny wants to know what is left of him in the city. He bets V that nobody remembers him right. The task is only to ask, in
three districts, three kinds of ordinary people, without saying who is asking. It is the first time he asks V for anything that is not about him getting back at someone.

Stages:
1. `bet`: **talk**. He lays the rules: three kinds, three districts, V never says whose head is listening. Tags: V takes the bet (`in`), V says no (`no` -> ending `not-asked`).
2. `poll`: **walk or drive across districts, `archetype-talk`**. Three poll targets in any order: a street resident in Watson (Kabuki or Little China), a corporate worker at City
   Center (Corpo Plaza), a nightlife person in Westbrook (Japantown). The `district` event plus the archetype route say which kind V spoke to and where. V's words must carry
   the name (a screen for "Johnny", "Silverhand", "Samurai" in the 15 menu languages, a small word list, no model call). Johnny's remark after each one is a checkpoint line, a fixed
   line on the shared key and a normal short reply otherwise. The three can span a whole game day. Giving up (V says stop, or 24 game hours pass) -> `quit`.
3. `tally`: **talk**. Johnny scores the three answers like a critic. Tags: V says which answer was closest to the truth (`fair`), V says they were all wrong in the same way
   (`harsh`). Both go to `wall`. He is bad at winning the bet and worse at losing it.
4. `wall`: closing beat. A prepared `image` of V's own shot, sent when V is next at any `place` in the Kabuki wall set (or after 6 game hours).

Talk:
* ego first: he expects a legend, gets a nuisance, a shirt, a song people hum wrong
* the nomad-corporate-nightlife split as his own old audience, who bought the records and who paid the tab
* a flash of guilt when a worker says something about the tower, brushed off by a joke
* (`fair`) he admits one answer cut closer than any article: "that one knew what I was"
* his first plain thank-you to V, delivered as an insult

Outcomes:
* `wall` with three answers (+45): "You asked three strangers who Johnny Silverhand was and told him the truth about what they said." `history`: he refers to "the poll".
* `wall` with `fair` (+55): as above plus "he admitted one of them had him right."
* `quit` (+10), `not-asked` (-5, he calls V a coward the next time, once).
* Rewards: none (it is the casual one).

Images:
* `poll-wall.png`, V's own shot, sent at `wall` with the caption "Someone gave me a moustache. Fix that.": a Kabuki wall with layers of peeling gig posters, a faded SAMURAI logo
  under a newer sticker, a marker moustache on a half-torn face, neon from a noodle sign across the street, game-look photo mode, no faces except the paper one.

Build: `party` figure (existing), `district` (existing), `archetype-talk` (existing, with the three kinds as a pack list: small addition), a word-list screen on V's words
(small), `image` with the V's-own-shot flag (new, `image` variant), `place` for the wall set, `history` (new).

Lines: see BOND_QUEST_LINES.md, Johnny SH1

### SH2. Dial Surf (`johnny-dial-surf`)

Gate: bond 4, `q108_johnny` (the old memory that starts in a dressing room with Kerry) finished, no `q108` or `sq011` quest active. Any relationship. Needs radio events
(`mod/media-song.lua`).

Premise: Johnny cannot sleep and V's body is awake anyway. He asks V to go out on the balcony of V's flat (Megabuilding H10, Kabuki) and just turn the radio on. He wants to know
if any station still plays something he would admit to. It is the quiet one: a figure on a balcony railing nobody else can see, and a city that does not know it is being judged.

Stages:
1. `night`: **talk**. He asks, grumpily. Tags: V agrees (`yes`), V says not now (`later` -> `later` ending, can be offered again after 2 game days).
2. `dial`: **radio check with presence**. V stands or sits on the balcony `place` (V's flat in Megabuilding H10, a point with a 4 m radius) with the pocket radio on, `together`
   for 20 game minutes. Each time V changes station or a new song starts (the `radio` event), Johnny gets one short remark (an automatic checkpoint remark, at most one per 2 game
   minutes). The pack keeps a list of the stations V passed and the songs that played.
3. `ask`: **talk and `check`**. Johnny asks V to leave it on the one thing V would defend. A `check` reads the current station and song. Tags: V names why (`defends`), V says it
   is only noise (`noise`). If a SAMURAI song happened to play during `dial` (the radio event says so, `verify` that the game's own stations carry any), his reaction is a separate
   branch `heard-me` with three lines of silence in the note.
4. `quiet`: **sit**. He asks V to switch it off and listen to the city for 10 game minutes (`together`, seated on the balcony ledge or chair if the flat has a `seat` point). He
   talks about the dead quiet of the night before a show and, for the first time, Alt, only in two sentences.

Talk:
* a critic's verdicts on each song: "bought", "borrowed", "that one has teeth"
* what makes a song a Samurai song and what makes one a jingle, kept to his perspective
* how a rockerboy hears a city: the noise is the rhythm section
* (`heard-me`) he says nothing for a moment and then changes the subject badly
* Alt, in two sentences, then back to the radio

Outcomes:
* `quiet` (+45): "On a night V could not sleep, you made V go out on the balcony and judge the radio together, and you did not say what you were listening for." `history`: he now
  comments on V's radio in V's cars ("the dial surf").
* `quiet` with `heard-me` (+60): adds "and you heard yourself."
* `later` (+5), `left` (+15, V went in before the end).
* Rewards: none.

Images:
* `dial-surf-balcony.png`, V's own shot, sent at `quiet` with the caption "Turn it up. No, off. Leave it.": a megabuilding balcony rail at night, a small pocket radio with a green
  dial, the Kabuki skyline in rain haze behind, a half-drunk can on the ledge, game-look photo mode.

Build: `place` (V's flat balcony, a fixed point shipped with the pack), `together` (new), `radio` + `check` (existing events, the `check` is new), `seat` (existing, optional),
`image`, `history`. The remarks are the battle-remarks route reused for checkpoint events (existing pattern).

Lines: see BOND_QUEST_LINES.md, Johnny SH2

### SH3. Field Manual (`johnny-field-manual`)

Gate: bond 5, `q108_johnny` finished, `johnny-dial-surf` finished (`after`), no `q108` or `sq011` quest active. Any relationship.

Premise: Johnny says V fights like a mercenary on a payday, and he fought like a soldier on a bad day. He wants to hand over three rules that kept him alive in the army. He can't
shoot, he can't carry, he can only say, so V must be the demonstration. A ruined depot in the Badlands is full of scavs who will never be missed.

Stages:
1. `brief`: **talk**. The three rules in his words: read the ground before you move, count before you pull a trigger, always leave one door. Tags: `learn`, `no` (-> `no`).
2. `approach`: **ride**. V drives out to the depot `place` (the old dry reservoir outpost at Jackson Plains, `verify` the exact spot) with him in the passenger seat. `ride` has no
   time limit here, only the destination. Johnny narrates what a soldier sees in the road.
3. `rules`: **stealth into fight**. At the depot, a `squad` of 6 scavs in two groups of 3, relaxed at start, second group on a patrol that ends in alert after 90 s of V being
   inside the place. Rule one: a stealth phase on the first group (`unseen`). Rule two: V is told to take the high ground before the second group (a `check` that V stood
   at a height point, a small inner `place` on the depot's water tower, 5 m radius). Rule three: when the second group goes alert the pack opens a retreat `place` (the road),
   and V must reach it or finish the squad. His checkpoint remarks come at the first silent takedown, at the alert, and at the last enemy down.
   * first group down without alert and tower reached, second group down: `clean`
   * alarm raised or the tower skipped, squad down: `loud`
   * V leaves the place with the squad standing: `fled`
4. `walk-back`: **talk on the truck bed**. He talks about soldiers who stopped counting, and that his own mistakes were arithmetic as much as anger. V sits on the tailgate of V's
   car or a wreck (`seat` on a ground workspot, 10 game minutes).

Talk:
* a soldier's voice, short and cold, without the usual swagger, which is what makes it land
* the rule he broke himself, and the day he stopped counting, told in three sentences with no names
* (`clean`) a rare compliment about patience, which he hates giving
* (`loud`) mocking, then a flat "you're alive, that's the grade"

Outcomes:
* `clean` (+55): "Johnny taught you three rules in a ruined depot in the Badlands, and you used all three." `history`: his fight remarks now name the rules ("rule two, V").
* `loud` (+40), `fled` (+10), `no` (+0, he says he'll wait).
* Rewards: none, the rules are the gift.

Images:
* `field-manual-depot.png`, V's own shot, sent at `walk-back` with "Third rule. Always leave an exit.": a rusted water tower over a ruined depot at golden hour, long shadows,
  a row of empty crates, a single road leading out toward the horizon, game-look photo mode.

Build: `ride` (new), `squad` with two groups and a timed alert (new, on the squad spawner), `unseen` (new), a height `place` (inner radius, new), `seat` workspot (new), `history`
(the fight remarks upgrade reads it: `battle-remarks`, existing). No weapon use by him: he is a figure.

Lines: see BOND_QUEST_LINES.md, Johnny SH3

### SH4. Licensed to Thrill (`johnny-licensed`)

Gate: bond 6, `sq011_concert` (the concert at Red Dirt) finished, none of his quests active. Any relationship. Heat must be zero to start.

Premise: V walks past a Japantown shop window and Johnny sees his own face on a cheap shirt, a keychain and a can of a fictional energy drink called "Silverhand Ultra". He wants
to know who signed the licence. The shop owner doesn't know. A delivery car leaves with a rep inside. He can't follow. V can.

Stages:
1. `window`: **walk**. A `place` at the shop (a Japantown street shop, `verify`), where V stops for at least 10 seconds. Johnny rants. Tags: V says they'll find out (`follow`), V
   says leave it (`leave` -> `shrug`).
2. `tail`: **tail, a chase in reverse**. A `runner` (a nameless rep in a sedan) drives a fixed route Westbrook -> City Center -> Watson to an office `place`. V must follow within
   150 m but not within 15 m for more than 10 s (a slow watch, 1 Hz, only while this stage waits). Too close: the rep notices and speeds up (`spooked`, a normal chase for 60 s
   before he stops at the office anyway). Too far for 20 s: `lost`. Johnny's checkpoint remarks come at the first junction, at a long red light and at the last turn.
3. `office`: **negotiation by talk (npc-react)**. At the office `place` the rep (a `cast` extra, corporate archetype, with a stage note that he is a small licensing contractor with
   no power) gets out. V may: ask who signed (`ask`), mention that the face on the can is not paid for (`bluff`), threaten (`threat`: npc-react cower or call the police, which
   raises heat and ends the stage with `heat`), or walk away (`walk`). Johnny, who nobody else hears, interrupts each line in V's ear.
4. `shirt`: **optional `gear` check**. If V is wearing a SAMURAI-logo garment from the game (`verify` that one exists), the closing beat has an extra branch (`wearing`). Johnny has
   to say something kind about it and cannot.

Talk:
* ego at its funniest: the shirt is the wrong colour, the can is a lie, the face is "from the good side, which is not a side I have"
* the licence as a small version of what he fought: a corporation selling the face of a man who said the opposite
* a reluctant admission that the contractor is just a man with a paycheck
* a flash about Kerry: "he'd have taken the royalties, and he'd have been right"

Outcomes:
* `office` with `ask` or `bluff` (+50): "You tailed a licensing rep across Night City for him, and nobody got hurt over a can." `history`: he calls any ad he sees "licensed".
* `office` with `wearing` (+10 more).
* `spooked` (+30), `lost` (+10), `heat` (+15, "you made it an incident"), `shrug` (+5).
* Rewards: none.

Images:
* `licensed-window.png`, V's own shot, sent at `window`: a crowded Japantown shop window of cheap shirts, mugs and plastic keychains printed with Johnny's face, a lit SAMURAI logo,
  V's faint reflection in the glass, neon, game-look photo mode.
* `licensed-can.png`, sent at `office` with "Even the can is lying.": a crushed silver energy-drink can on a wet curb, the printed face half-scratched off, game-look.

Build: `place`, `runner` in a new **tail mode** (follow-distance bounds, a slow watch for the two bounds, no ramming), `cast` with a stage note (new, small), `npc-react` on the cast
extra, `heat` (existing), `gear` check (existing, `verify` the logo item), `image`, `history`.

Lines: see BOND_QUEST_LINES.md, Johnny SH4

### SH5. The Count (`johnny-the-count`)

Gate: bond 8, `sq031_rogue` (Chippin' In) finished, `johnny-field-manual` finished (`after`), no `q108`, `sq011` or `sq031` quest active. Any relationship.

Premise: Johnny has never said the number of people the tower took. He says he never counted, and tonight he wants to hear it said aloud by someone who is not his enemy. He asks V
to take him to a quiet shrine above Corpo Plaza. A stranger will already be there.

Stages:
1. `ask`: **talk**. The plainest he has been. Tags: `yes`, `no` (-> `no`, he never asks again for 3 game days).
2. `walk`: **walk**. V goes on foot from the nearest transit stop to the shrine `place` (a small memorial lookout over Corpo Plaza in City Center, `verify` that a memorial lookout
   exists there, else the pack uses the plaza's upper terrace). The walk is the point: `party` figure, 12 game minutes, no fights.
3. `elder`: **sit with a stranger, `archetype-talk`**. On the bench a `cast` extra, an old man with a candle (corporate-district resident archetype, a stage note: lost a spouse
   in 2023, hates "that rockerboy", doesn't know V). V can say nothing (`silent`), or speak to him. His reaction follows the ordinary NPC rules (he leaves, tells V off, or stays).
   Johnny hears all of it. If V speaks Johnny's name, the old man's answer is his own.
4. `count`: **talk**. After the old man has gone (or not), Johnny asks V to say the number out loud with him, for a count he never made. He does not narrate the day. The pack
   gives no figure (hard: the engine can't verify one and the lines don't state one). Tags: V says it with him (`with`), V just sits (`sit`).

Talk:
* no jokes for four turns, which is the loudest thing he has done
* the old man as a mirror: his anger is right, and Johnny agrees with it out loud
* "I was right and I was wrong and the people in the wrong are the ones who count"
* respect for V that is almost a request: that V not turn it into a cause

Outcomes:
* `count` with `with` (+80): "At a quiet shrine above Corpo Plaza you sat beside a stranger who hated Johnny and said what Johnny never counted." `history`: he never makes the joke again.
* `count` with `sit` (+70).
* `elder` with `silent` and a leave (+60: V let the old man have his night).
* `no` (+0), `walked-away` (+15).
* `memory-share`: Rogue's copy (if V has one) knows V took him there, as a short line (talk only for the game-placed Rogue).

Images:
* `count-candles.png`, V's own shot, sent at `count`: small candles in red glass on a stone ledge above a plaza, a lit megatower in the haze, an old man's hand lighting one, no
  faces, game-look photo mode.
* `count-street.png`, a memory frame, sent a day later with "That's what it looked like. Not the footage. That.": a grainy street after a blast, yellow tape, a half-fallen shopfront,
  firefighters at a distance, no bodies, an overexposed 2023 look.

Build: `party` figure + `place` + `together`-style walk (new), `cast` with a stage note (new), `archetype-talk`, `npc-react`, `image` (two variants), `history`, `memory-share`.
"Hard": no number is ever given by the data, and nothing in the scene touches a game memorial.

Lines: see BOND_QUEST_LINES.md, Johnny SH5

### SH6. Soundcheck (`johnny-soundcheck`)

Gate: bond 10, `sq031_rogue` finished, `johnny-the-count` finished (`after`), none of his quests active. Any relationship.

Premise: Johnny doesn't ask for a favour. He asks to stand on a stage once more, with no one watching. A club stage at five in the morning will do. Then he says what V's body has
been to him, and asks, for the first time, instead of taking. V decides what happens.

Stages:
1. `call`: **`johnny-voice` or talk**. He asks. "Not a show. A soundcheck." Tags: `yes`, `no` (-> `no`).
2. `venue`: **arrive**. V goes to the Totentanz stage in Westbrook (`verify` that V can enter while the club is empty at 5 a.m., else the pack uses the Afterlife floor).
   A `place`, V on the stage within 2 m of the mic stand.
3. `check`: **timed presence on the stage**, `together` 10 game minutes, with `check` (hour 05:00 +/- 1). He walks the edge of the stage, which a figure can do, and tells V what the
   room used to sound like. He asks V to say one word into the mic. Tag: V says it (`word`) or doesn't (`silent`).
4. `wheel`: **choice**. He says, plainly: he has been using V's body for weeks and never asked. Now he asks for one line, spoken by V's mouth. Tags: `yes` (V says the line
   in chat as V's own words, and Johnny's `johnny-voice` answers with his), `no` (he accepts, and says so), `together` (V picks a line and Johnny chooses a different one, said in
   turns). The mod never moves V. The line is V's own chat message. Alt's name comes up in the answer to `yes`.
5. `out`: **walk out**. V leaves by the front. Dawn on the street. He is quiet.

Talk:
* the room before a show, told like a soldier's brief and a musician's confession
* the one thing he is afraid of: that this body will keep going after he is gone, and that V will keep carrying his voice
* respect that is no longer a joke: he names V's choices, not his own
* Alt, one line, no explanation
* (`no`) his surprise that he is relieved

Outcomes:
* `wheel` with `yes` (+100): "In an empty club at dawn Johnny asked for a line instead of taking it, and you gave him one in your own voice." `history`, permanent: he never says "my body"
  of V's again.
* `wheel` with `together` (+100), `wheel` with `no` (+90, "you told him no, and he respected it more than a yes").
* `venue` without `check` (V left early: +40).
* Rewards: none. His last gift is a change in his talk.

Images (the top quest, up to 6):
* `soundcheck-stage.png`, V's own shot, sent at `venue`: an empty club stage at dawn, one mic stand under a work light, chairs upturned, a roadie's coil of cable, a stripe of daylight
  through a door at the back, game-look photo mode.
* `soundcheck-mic.png`, V's own shot, sent at `check`: a close shot of a mic stand with a strip of tape on the base reading "SILVERHAND" in marker, shallow depth of field.
* `soundcheck-mirror.png`, a memory frame, sent at `wheel` with "Don't look. It's only the mirror.": V's reflection in a backstage mirror, and half a second behind, a bearded man in
  aviators, the old-footage tint, a dressing-room mirror with bulb lights.
* `soundcheck-dawn.png`, V's own shot, sent at `out`: a Japantown street at first light, a delivery drone crossing the sky, V's long shadow on the pavement and a second one,
  slightly offset, game-look photo mode (the second shadow is the point of the image).

Build: `johnny-voice`, `place` + inner radius, `together` with a `check` on the hour, a choice stage (talk tags), `history`, `image` (V's-own-shot and memory-frame variants). "Hard":
no song, no instrument, no voiced new game lines. The `yes` line is V's chat message and his `johnny-voice` reply, both ordinary turns.

Lines: see BOND_QUEST_LINES.md, Johnny SH6

### Johnny: scripted lines, holocalls and talk gaps

The scripted lines, the holocall scripts and the talk gaps (and the music and sound notes) of SH1 to SH6 are in [BOND_QUEST_LINES.md](BOND_QUEST_LINES.md), under Johnny Silverhand, quest by quest.

### Johnny reaches out first (inside V's head: no phone, he just speaks up)

Channel is `johnny-voice` for all of them. Cooldown applies to the whole list at once, minimum 4 game hours between any two.

| id | Trigger | Opening line(s) | Cooldown | What the LLM knows when V answers |
|---|---|---|---|---|
| SHR.01 | Bond level-up (3, 4, 5, 6, 8, 10) | "Huh. Level up. You're keeping me around. Fine. Don't make it weird." | 1 per level | the new level title, that V did not ask him to speak, he is gruff about being liked |
| SHR.02 | After `q101_01_firestorm` ends (once) | "That tower. Don't ask me about the tower. ... Ask me about the tower." | once | the 2023 memory V just relived, his guilt is his own testimony, no figures |
| SHR.03 | V's radio plays a rock song for 30 seconds (radio event) | "Turn it up. No. Down. This is a copy of a copy of something we did first." | 12 game hours | the song title from the radio event, his critic's ear, no lyrics |
| SHR.04 | 03:00 to 05:00 and V idle for 3 game minutes | "You're up. I'm up. We're a pair of insomniacs sharing a skull." | 24 game hours | the hour, V's activity, he may bring up Alt in two sentences if the bond is 5 or more |
| SHR.05 | V enters City Center / Corpo Plaza (district event) | "Look at that tower. Bigger than the last one. They always rebuild bigger." | 24 game hours | the district, Arasaka, his 2023 guilt, V's last view of the tower |
| SHR.06 | V wears an Arasaka-logo item or visits Arasaka-owned ground (gear or district check) | "Is that Arasaka? Take it off. Or leave it. Your funeral. Mine too." | 12 game hours | the item name from the `gear` read, his hatred, humour as a deflection |
| SHR.07 | After V finishes `sq031_rogue` (Chippin' In), once | "That went... better than I expected. Rogue looked at me. Through you. I felt it." | once | Rogue's role, the hunt for Smasher, Johnny's unresolved history with her |
| SHR.08 | V finishes a Johnny bond quest (SH1 to SH6) | "That was fine. I'll deny it. But it was fine." | 1 per quest | the quest just finished, its ending, what he took from it |

### Johnny hangouts (Santo Domingo, City Center, Heywood outside the Glen)

#### SHH1. Perimeter (Rancho Coronado, Santo Domingo), unlocks at bond 3

* **Invitation** (`johnny-voice`, trigger on entering Santo Domingo or at 09:00): "Suburbs. Disgusting. But I want to know how I'd hold a cul-de-sac. Come on."
* **Activity**: **timed scavenger**. Within 8 game minutes, V reaches three vantage `place`s that Johnny calls out in order (a hedge, a garage roof, a corner mailbox). At each, a `check` of the hour and weather
  sets his remark. All three: `perfect`. Two: `good`. One or none: `walk-of-shame`.
* **Twist**: a neighbour's barbecue (`cast` extras) stops V at the second point and talks to V like a stranger (ordinary NPC rules). Johnny hates it, V decides whether to shake them off.
* **Gap SHH1.g1** after the second point.
  * **asks** `SHH1.g1.ask`, Johnny (copy), question, johnny_crossed: "Would you live here? Honest. Fence, lawn, and everyone knows your car."
  * **knows** the timer is running, a barbecue neighbour has V's ear, Johnny can't talk to the neighbour.
  * **secret** that he almost lived like this once.
  * **wants** V to answer fast and move on.
  * **idle** `johnny_crossed`.
  * **resumes on** V's reply or the next `place`.
  * **branches** a "yes" makes him laugh once. A "no" makes him nod.
* **Bond**: +6 accept, +4 for `good`, +8 for `perfect`.
* **Variations**: (1) dawn patrol, light fog, the second point is the school-bus stop. (2) night patrol, sprinklers on, points are a trash can, a parked truck, an upstairs window. (3) rain, the neighbours stay indoors, so the twist is a leaf blower.
* **Image**: none.
* **Build**: `place` x3 (new, short chain), a timer, `check` (hour, weather), `cast`, `npc-react`.

#### SHH2. Bet on the Bystander (Arroyo, Santo Domingo), bond 4

* **Invitation** (`johnny-voice`): "Here's a game. I bet how a stranger reacts. You make it happen. Loser buys nothing."
* **Activity**: **prediction game, `archetype-talk` and `npc-react`**. Three requests V must make to three ordinary people (ask a food vendor for a free taste "for a famous man", ask a loiterer to move on,
  tell a mechanic V likes the sign). Before each, Johnny bets a reaction (leave, cower, obey, laugh, ignore). The result is the ordinary NPC reaction. 3 correct bets: `genius`. 2: `fair`. 0 to 1: `lost`.
* **Twist**: one stranger always reacts in a way nobody bets on (the pack seeds one wild reaction).
* **Gap SHH2.g1** after the second bet.
  * **asks** `SHH2.g1.ask`, Johnny (copy), question, johnny_shades: "Bet your pick. What does he do? Don't think, just say."
  * **knows** the three requests, the bets so far, V's pick is stored against the data.
  * **secret** that he loves being wrong.
  * **wants** V to commit.
  * **idle** `johnny_shades`.
  * **resumes on** V's pick.
  * **branches** V's pick is compared with the real reaction for a bonus line.
* **Bond**: +6 accept, +3 `fair`, +6 `genius`, +8 if V beats Johnny.
* **Variations**: (1) market vendors. (2) three people at a transit stop. (3) three drivers at a gas station.
* **Image**: none.
* **Build**: `archetype-talk`, `npc-react`, a bet tag (new), `cast`.

#### SHH3. Wardrobe Veto (City Center, the shopping levels near Corpo Plaza, verify), bond 5

* **Invitation** (`johnny-voice`): "That jacket. No. We're going shopping. Don't argue."
* **Activity**: **`gear` check**. Three challenges, each a look V puts on: (1) nothing with a corporate logo, (2) something he'd wear on stage, (3) the worst thing V owns. After each, a `gear` read and his verdict.
* **Twist**: if V puts on any Arasaka item, Johnny gives a short furious speech, ends the round and declares V "the enemy" until V changes. At the end he insists V keep one piece of the second look on.
* **Gap SHH3.g1** after the second look.
  * **asks** `SHH3.g1.ask`, Johnny (copy), question, johnny: "Why do you dress like that? I don't mean it's wrong. I mean what's it for?"
  * **knows** the `gear` read, Arasaka veto, his love of sleeveless and leather.
  * **secret** that he wore the same jacket for years because it was his only one.
  * **wants** V to answer honestly.
  * **idle** `johnny`.
  * **resumes on** V's reply or a 3-game-minute timer.
  * **branches** a defence of the look makes him respect it. A shrug makes him tease.
* **Bond**: +6 accept, +3 per passed look, +8 for all three.
* **Variations**: (1) daytime, rain gear. (2) a funeral outfit. (3) "dress as someone you're not".
* **Image**: 1, `wardrobe-veto.png`, V's own shot: a clothing rack in a bright arcade, one jacket pulled out and hung on a hook, a lens flare. Caption: "That one. Maybe."
* **Build**: `gear` (existing, reads worn items), `place`, `image`.

#### SHH4. What Do I Know About You (Heywood, Wellsprings bar, verify), bond 6

* **Invitation** (`johnny-voice`): "Sit at a bar. Order something. I'll tell you four things about you. One is a lie."
* **Activity**: **truth-or-lie game, `seat` at a bar and `check` reads**. Johnny states four claims about V built from live reads (eddies band, what V wears, the hour, the weather, the district). One is false. V picks
  which. Right: +. Wrong: Johnny gloats.
* **Twist**: a stranger (`cast`, nightlife) sits by V and starts a conversation. Johnny coaches V's replies in V's ear and drops a false claim into the middle of it.
* **Gap SHH4.g1** after the fourth claim.
  * **asks** `SHH4.g1.ask`, Johnny (copy), question, bar: "So? Which one's the lie? And tell me what you wish I didn't know."
  * **knows** the four claims, the data for each, the stranger's stage note.
  * **secret** that he borrows V's memories more than he lets on.
  * **wants** V to commit and be a little honest.
  * **idle** `bar`, an elbow on the bar.
  * **resumes on** V's pick.
  * **branches** right -> a rare compliment. Wrong -> a victory lap.
* **Bond**: +6 accept, +4 right, +2 wrong but honest.
* **Variations**: (1) claims about the day's route. (2) claims about the car. (3) claims about V's recent kills (no counts).
* **Image**: none.
* **Build**: `seat` bar, `check` (eddies band, gear, hour, weather, district), `cast`, `npc-react`.

#### SHH5. Shakedown (Heywood, a street cart in Vista del Rey, verify), bond 7

* **Invitation** (`johnny-voice`): "Three punks are leaning on a cart vendor. Not my fight. Not my body. Your call."
* **Activity**: **protect the vendor, `squad` and `cast`**. Three relaxed ganger-types squeeze a cart owner for protection money. V decides how: talk them off (`npc-react`), pay for the vendor (`eddies`), or fight (`squad`). The vendor must end unhurt.
* **Twist**: the "punks" are teens with toy guns. Johnny calls it as the squad turns. V can still fight, but the bond bonus goes to the one who spots it.
* **Gap SHH5.g1** after the squad notices V.
  * **asks** `SHH5.g1.ask`, Johnny (copy), question, johnny_aggressive: "Hit them or talk them? I'd hit them. That's why I'm dead."
  * **knows** the three punks, the vendor, the toy-gun twist, V's options.
  * **secret** that part of him wants V to lose his temper.
  * **wants** V's own decision.
  * **idle** `johnny_aggressive`.
  * **resumes on** V's action.
  * **branches** a talk resolution gets a grudging nod. A fight gets a warning.
* **Bond**: +6 accept, +4 talk, +3 pay, +2 fight, +8 if the vendor thanks V.
* **Variations**: (1) a flower stall. (2) a food truck at night. (3) a fixer's courier ambushed.
* **Image**: none.
* **Build**: `squad` (relaxed, new use), `cast`, `npc-react`, `eddies` pay-an-NPC (small).

### Johnny's gifts

* **Loved**: strong whisky or bourbon, vintage rock or punk media (cassettes, vinyl, old music shards), aviator-style glasses, sleeveless leather jackets and vests, handmade anti-corporate items (a "burn the tower" sticker is fine).
* **Liked**: cigarettes or cigars, a pistol with an old-school feel (in V's hands), a plain black T-shirt, a worn pair of boots, a decent coffee.
* **Disliked**: anything Arasaka (clothing, ads, drinks), corporate-branded gifts, health boosters that make V feel nothing, "motivational" decor.

| id | tier | speaker | line | emotion | animation |
|---|---|---|---|---|---|
| SHG.loved | loved | Johnny (copy) | Good whisky. Where did you find that? ...Never mind. Drink it for me. | happy | johnny_smoke |
| SHG.liked | liked | Johnny (copy) | Fine. It's not bad. You're learning. | nod | johnny |
| SHG.disliked | disliked | Johnny (copy) | Arasaka? Seriously? Take it away. Burn it. | angry | johnny_aggressive |
| SHG.give.common | common | Johnny (voice) | Take it. It's nothing. A cigarette from the old days. | neutral | johnny_smoke |
| SHG.give.uncommon | uncommon | Johnny (voice) | A spare pair of shades. Don't lose them. | neutral | johnny_shades |
| SHG.give.rare | rare | Johnny (voice) | A jacket like mine. Wear it. Don't make it a costume. | nod | johnny |
| SHG.give.epic | epic | Johnny (voice) | Something I kept for years. Don't ask where it came from. | sad | johnny_crossed |
| SHG.give.legendary | legendary | Johnny (voice) | My aviators. Not a prop. Wear them when it counts. | sad | johnny_shades |

---

## 7. Viktor Vektor

Canon anchors: a ripperdoc with a no-nonsense clinic behind Misty's Esoterica in Little China, Watson, who rents the space from Misty and calls
that one of his best decisions. A former boxer with the Night City Devils who placed second in the Watson Boxing Grand Prix, still watches the
sport and calls punches at the screen. He patched up V and Jackie in the prologue (`q001_01_victor`), carried the 21,000 eddies for V's Kiroshi
optics (`mq045_victor_debt`), and looked at the tarot graffiti with Misty (`mq033_tarot`). Jackie was his friend and boxing pupil, and Viktor
remembers how hard Jackie hits. He dropped the race to be somebody ("sleeping better is a decent trade"), is dry and economical, asks "what
changed" before anything else, and does not claim to know Militech's secrets or to cure what he cannot. He is a doctor and an old fighter, never a
merc: in every quest below he teaches, treats, watches or is in danger, and the only blows he throws are in a ring. The game-placed Viktor stays in
his clinic and only talks. The mod's copy meets V elsewhere (a `meet` at a place a block or more from the clinic). Every quest that touches his
craft stays on the right side of what the engine can do: no surgery minigame, no real procedure (all "hard", with the closest version named).
Jackie's state follows the save (alive before the Heist, gone after it), and the pack reads that from the turn, never from a stored fact.
Ladder: 3, 4, 5, 6, 8, 10.

### V1. Ringside (`viktor-ringside`)

Gate: bond 3, `q001_01_victor` (The Ripperdoc) finished, none of his quests active. Any relationship. Needs Immersive invitations.

Premise: the old Devils gym runs an amateur card on the first Friday of the month and Viktor goes alone, to the same folding chair, every time. He
mentions it as an afterthought, sure that V would hate it. It is the first time he asks anybody to sit next to him.

Stages:
1. `invite`: **text + meet**. "Friday card at the old gym. Free seats, bad coffee. You'd hate it." `meet` at the gym `place` (the old Devils gym
   in Watson, the exact spot captured in game, verify the club's real place), evening, within 4 game hours. Stood up: ending `empty-seat`.
2. `card`: **spectate with commentary**. `seat` on the folding chairs at ringside, `together` seated, 30 game minutes. Three `bout`s between nameless
   amateur pairs (`cast` fighters in headgear, fists only, a count of ten ends each one, 90 s at most) start at minutes 0, 10 and 20. Viktor calls
   the punches under his breath and says what each fighter is doing wrong. Before each bout V picks a corner by saying a name (tags `red` or `blue`)
   and he tells V what V's pick has going for him. Viktor is not betting and says so. V may put 100 to 500 eddies on a bout with a `cast` bookie
   (the small "pay an NPC" flow), tag `bet`, and he answers with one dry line.
3. `bag`: **guard drill, short**. After the last bout he walks V to the heavy bag corner (`place`, 3 m). V stands there two game minutes while he
   corrects the stance and the breathing in words. He shows it himself on the bag (`workspot`, verify the gym has a bag workspot, else he leans on
   the ropes and shows it with `gestures`). Hard: V's own punches cannot be read or graded, so he grades only what V says and where V stands.
4. `walk-out`: closing beat, a prepared `image` after V leaves.

Talk:
* the stands as the one place nobody asks him what he does for a living
* what the fighters do wrong, said kindly, and what he would have done at their age
* why he watches: not for the winner, for the moment a man stops pretending the glove is a wall
* Jackie, depending on the save: a dry fond line while Jackie is alive, a silence and a nod afterward
* (`bet`) "Tell me you're not betting" after he said he does not

Outcomes:
* `stayed` (+45): "You took V to the Friday card at the old Devils gym and talked them through three bouts." `history`: he calls it "the Friday seat".
* `stayed` with `bet` (+45): the same, and he now and then teases V about a lost or won bet.
* `left` (+15): "V came to the fights but did not stay for the last bout."
* `empty-seat` (-5): "You kept a seat free and V never sat in it." He mentions it once, flatly.
* Rewards: none (the casual one).

Images:
* `ringside-ropes.png`, sent after V leaves with "Your pick lost. Mine didn't.": a boxing ring seen from the second row of a small gym through
  the lower ropes, a worn canvas, two fighters clinched under one hard white lamp, blurred folding chairs in the foreground, one empty seat with
  a paper coffee cup on it, game-look photo mode, warm and grainy.

Build: `meet` at a `place`, `bout` (new: two `cast` fighters in a fists-only exchange that ends by a timer or a count and never involves V), `seat`
on folding chairs, `together`, `cast` bookie with the small pay-an-NPC `eddies` flow, `gestures`, `workspot` (verify), `image`, `history`.

Pins: the meeting point, the old Devils gym in Watson.

Lines: see BOND_QUEST_LINES.md, Viktor V1

### V2. Night Calls (`viktor-night-calls`)

Gate: bond 4, `mq045_victor_debt` (the 21,000) finished, none of his quests active. Any relationship. Eddies on.

Premise: Viktor does house calls after midnight for people who cannot or will not come to a clinic, and he has stopped driving after dark in this
town. He has three calls tonight and asks V for the car, the way someone asks a friend for a lift to the airport.

Stages:
1. `ask`: **text**. "Got a car and a free night? Bring both." `meet` at a `place` a block from the clinic (a noodle bar corner in Little China),
   within 2 game hours. Stood up: `no-ride`.
2. `calls`: **ride with three stops**. V drives with Viktor as passenger (`ride`, no heat). Three ordered `place` stops, each a short walk inside:
   a back room behind a Kabuki stall (a vendor with a failing hand implant), a dock locker room in Northside Industrial (a worker with an
   infected spine port), and a flat in Heywood (a grandmother whose heart implant skips). At each stop V stays at the door or goes in. A `cast`
   patient and one `archetype-talk` neighbour of the right kind in the district tell V what happened, and Viktor teaches by doing it: "ask what
   changed, not what hurts". He treats in words and gestures only (hard: no procedure, no minigame: he works with `gestures` and his bag, and the
   pack never claims the patient is cured, only that he left them better). Limit: all three before 5 AM game time, else `dawn`.
3. `tab`: **eddies twist**. At the third stop the patient cannot pay and says "put it on my tab". Viktor says nothing. V may pay the patient's
   share (an `eddies` payment to an NPC, 300 to 1,000, V's choice of amount) or stay out of it (tags `paid`, `stayed-out`). His line about the
   21,000 V once owed him is the answer in either case.
4. `drop`: **ride** back to the corner where V picked him up. Closing beat, an `image`.

Talk:
* his bedside manner: short questions, no flattery, a joke only when the patient is calm
* why a clinic of one is mostly unpaid: "I've carried worse tabs than yours" (the debt, said lightly)
* each patient as a person, not a case: the vendor's stall, the dock worker's shift, the grandmother's cat
* three questions he asks V at the end, all of them about V, none about the chrome
* when V pays: he says nothing, then "That's not how a tab works" and takes the empty paper cup out of V's hand

Outcomes:
* `all-three` (+55): "You drove Viktor on three house calls through the night." `history`: he sometimes calls V "my driver".
* `all-three` with `paid` (+60): the same, "and V paid a stranger's tab without being asked."
* `dawn` (+25): "V drove you on your calls but the night ran out before the third."
* `no-ride` (-5): "You asked V for a ride and they never came."
* Rewards: none in eddies (he does not pay for lifts). He may mark V's next visit as free (a `history` line he repeats).

Images:
* `night-calls-case.png`, sent after the drop with "Tonight's third patient sends her thanks.": a car's passenger seat at night, a worn medical bag
  on a pair of knees, a stethoscope looped over the bag handle, neon from a Heywood street on the dashboard, wet window, game-look photo mode,
  no face.

Build: `meet` at a `place`, `ride` with ordered stop `place`s and short on-foot legs (new combination, small), `cast` patients, `archetype-talk`
neighbours, the pay-an-NPC `eddies` flow (new, small), `gestures`, `history`, `image`.

Pins: the meeting point, the noodle bar corner in Little China, a block from the clinic.

Lines: see BOND_QUEST_LINES.md, Viktor V2

### V3. The Third Card (`viktor-third-card`)

Gate: bond 5, `mq033_tarot` (Tarot) and `mq045_victor_debt` finished, none of his quests active. Any relationship. Needs the mod's copy of Misty
(if she is not available the quest does not start).

Premise: Misty makes him slow down, and Viktor has never thanked her in words. He is better with his hands: he has been building a windchime out
of retired implant casings and brass that rings when a door opens. It is ugly and he knows it. He cannot finish it with her anywhere near. He asks
V for the one thing he is bad at: keeping Misty busy.

Stages:
1. `plot`: **talk**. At V's flat (`meet` home) he explains, sheepishly. Tags: V takes the job (`in`), V says just give it to her (`no`, he argues:
   "she'd see my face", then agrees to try with V, still `in`).
2. `reading`: **sit and keep her there**. Misty's copy sits at a `cast` card table in the Little China night market (the exact stall captured in
   game). V sits across from her (`seat`, `together` seated within 8 m of the table, 15 game minutes) while she gives V a three-card reading
   (talk, with a different card in each third). Viktor's copy works out of sight a few hundred metres away (`post` at a `workspot` bench in a
   courtyard). Every few minutes Misty remembers something at the shop (a timed `cast` beat): V must keep her in her chair by talk. If V walks off,
   she follows V and the timer breaks.
3. `reveal`: **three-way scene**. Viktor arrives with the chime in a paper bag and says it badly. Misty's reaction is the heart of the quest.
4. `hang`: closing beat. The game-placed Misty at her shop only talks: her line later mentions the chime (`memory-share`).

Talk:
* the reading: Misty's method of past, expectation and intuition, never a prediction of V's route, and the third card is the one that tells V
  to look at the person who stays quiet in the room
* Viktor, who does not believe in cards, being told that the Hermit is him and not minding
* the chime: "ugly and beautiful" is her phrase and she means both
* Misty on slowing him down: she never tried to cure him of anything
* Viktor admits, to V only, that the thanks he cannot say is the only job he ever found hard

Outcomes:
* `reveal` (+65): "You kept Misty at her table long enough for Viktor to finish his gift." `history`: the chime exists, hung at her door.
* `spoiled` (+45): Misty found Viktor soldering behind the stall. She laughed so hard she cried. He is mortified and delighted.
* `walked-off` (+15): V left the table and the surprise went wrong. Viktor is gentle about it.
* `memory-share`: the game-placed Misty (talk only) mentions the chime, and Jackie if the save has him in her life.
* Rewards: Misty offers V one free reading (a `history` line, not a game effect).

Images:
* `third-card-spread.png`, sent after the reading: three tarot cards on a dark cloth under a paper lantern (the Hermit, the Wheel of Fortune,
  Strength), a hand with chipped violet nails touching the middle one, incense smoke, game-look photo mode.
* `third-card-chime.png`, sent after the reveal: a windchime of brass tubes and grey implant casings hung in a doorframe at night, one casing
  still stamped with a faded corporate logo, neon behind it, game-look photo mode.

Build: `meet` (home and a `place`), `cast` (a copy of Misty, used as an extra at a table), `seat`, `together` with a "stay within 8 m" rule,
timed `cast` beats, `post` + `workspot` for Viktor, `image` x2, `memory-share`. No new primitive.

Lines: see BOND_QUEST_LINES.md, Viktor V3

### V4. Off the Books (`viktor-off-the-books`)

Gate: bond 6, V3 finished (`after`) and `mq045_victor_debt` finished, none of his quests active. Any relationship. Heat must be 0 at the start.

Premise: a street chopper in Kabuki (a new nameless man, harmless to canon) is installing cheap clones in people who cannot afford better, and three
of them have come to Viktor with infections and a lost hand. He is angry in his quiet way and does not want a fight. He wants to know what is in the
boxes and to make the man stop. He cannot walk in, everyone in the district knows his face. V can: V can walk in as a patient.

Stages:
1. `brief`: **talk**. In V's car on a Kabuki street, Viktor stays in the passenger seat (`post`) and speaks to V through `remote` while V is
   inside. Tags: V takes it (`in`), V wants to burst in (`loud`, he refuses: "then you're a patient with a gun"), V refuses (`no`).
2. `chair`: **undercover talk with a prompter**. The chopper's back room (a `place` in a Kabuki alley, verify a back-alley clinic spot). `gear` check at the
   door: V must have no weapon drawn (a drawn weapon ends the cover, ending `blown`). V sits (`seat`) and talks with the chopper (`cast`, ordinary
   NPC reactions, `npc-react`). Viktor feeds V the questions in V's ear ("say the arm lags when you reach", "ask where the chrome comes from",
   "ask to see the box before you sign"). V's answers carry two tags, `script` (V follows Viktor's line) and `improv` (V says it V's own way).
   The chopper's suspicion rises one step on every `improv` that contradicts the script and falls on every `script`. He relaxes enough to name his
   supplier, read the batch label off a box aloud, and offer V the "demo" install. V keeps refusing it politely.
3. `turn`: **the demo**. At a suspicion of 3 the chopper calls his two guards (`squad` of 2, relaxed in the next room) and says he will "check V's
   papers". V can talk his way out (`npc-react`), leave through the front door with the box number, or it becomes a short brawl in the alley.
   Viktor cannot help from the car, he can only say one calm line in V's ear.
4. `close`: **negotiation by talk**. At the door, V says what V learned. The chopper's reaction is the ordinary NPC decision: he shuts the clinic
   (`npc-react` leave or cower), threatens V (a fight), or bribes V. Viktor steps out of the car at the end only to say one sentence to him.

Talk:
* before: why he cannot just report it ("who would I report it to, and who would be next on the bed"), his disgust at cheap chrome that looks like
  a brand without the engineering
* in V's ear: calm, short, nothing clever, a patient's-chart voice
* after: what the batch label meant, what he will do about the three patients, a rare unguarded "thank you"
* (`blown`) he says it was the right call to drop the cover, and means it

Outcomes:
* `quiet-close` (+70): "You posed as a patient and talked a street chopper in Kabuki out of installing cheap clones. Nobody was hurt." Lasting: he
  adds V's name to the short list of people he trusts with a lie.
* `box` (+60): V got the supplier and the batch number from the chopper's own mouth and walked out clean. The chopper kept going. Viktor files the number somewhere he will not say.
* `brawl` (+40): "The guards turned. V got out, but the chopper knows your face now."
* `blown` (+30), `no` (+0).
* Rewards: none in eddies. If V wants, Viktor gives V a free checkup (a `history` line, he tests V's hands for tremor).

Images:
* `off-the-books-back-room.png`, sent after: a cramped back-alley ripperdoc chair under a bare bulb, a tray of mismatched implant boxes with
  hand-written labels, a cheap holo-sign in the doorway, as seen from the chair, game-look photo mode.
* `off-the-books-label.png`: close shot of a plain white box with a smudged batch number and a faked logo, a thumb pinning the corner.

Build: `post` for Viktor in V's car and `remote` coaching (new), `gear` check on drawn weapons (existing, a drawn-weapon read is new at a checkpoint),
`seat`, `cast` chopper with `npc-react` and a suspicion counter fed by `script` and `improv` tags (a small counter in the pack, no new primitive),
`squad` of 2 with a brawl rule. No `unseen`: this one is a talk quest with a brawl as its risk.

Lines: see BOND_QUEST_LINES.md, Viktor V4

### V5. Patient Confidentiality (`viktor-patient-confidentiality`)

Gate: bond 8, V4 finished (`after`), `mq045_victor_debt` finished, none of his quests active. Any relationship. Copy availability: the pack uses a
single Viktor copy spawned as a captive, so the quest only starts when no Viktor copy is in V's party.

Premise: a Maelstrom crew has a badly wounded packmate (a nameless young man) and nobody who will operate without paperwork or a price. They took
Viktor off a Little China street at gunpoint and they will not hurt him as long as the patient lives. He will not leave the patient, and he will
not stay if somebody shoots. V must get him out of there in a way that leaves the patient breathing, or the rescue is the wrong kind.

Stages:
1. `text`: **text + image**. A message from an unknown number: "Your doctor's with us. Come alone." with an `image` of his sunglasses on a van
   floor. Time limit: 40 game minutes to reach the place.
2. `approach`: **three ways in**. At the `place` (a dockside warehouse on the Watson waterfront, verify), a `squad` of 6 Maelstrom (relaxed) and a boss
   at the door (`cast`, an ordinary NPC). V chooses: talk in (the boss obeys or lets V see him, `npc-react`), sneak around the back (`unseen`),
   or fight. The warehouse has a `hostage` `place` at the back: Viktor, hands wrapped in gauze, at a makeshift table, the young patient on a door
   laid over two crates.
3. `ward`: **rescue with a rule**. V reaches Viktor (within 3 m). He will not leave. V must hold the ward: no combat inside the `place` radius
   (12 m) for 5 game minutes while he works (`together`, V within 6 m). Gunfire in the radius ends the operation (the patient dies, ending
   `lost-patient`). Combat outside the radius is fine, V may thin the squad quietly (`unseen`) or keep the boss talking.
4. `out`: **escort and ride**. Viktor follows V out (`hostage` as a temporary follower), V drives him to the clinic (`ride`). The patient is left
   with his crew, stable, and the crew lets them go.

Talk:
* in the warehouse: terse, at his sharpest, "I treat what's on the table. Ask me again after"
* to the patient, in words V only half hears: the same steady voice he uses on V
* afterwards: no speech about right and wrong, only a question about whether V is hurt, then a long silence in the car
* if the patient died: he does not blame V aloud, which is worse

Outcomes:
* `clean` (V talked or sneaked in, the patient lived, +90): "You walked into a Maelstrom hideout and got Viktor out with his patient alive."
  `history`: he says V can ask him for anything, once, and names it "the one on the house".
* `loud-but-saved` (V fought outside the ward radius, the patient lived, +75): the same, and he asks V to take a look at their own knuckles.
* `lost-patient` (shots in the ward, +30): a 3-day note: he is short, practical, never cruel.
* `too-late` (40 game minutes passed, +10): the crew let him go on their own. He is thinner for it.
* Rewards: none (the quest is the reward).

Images:
* `confidentiality-glasses.png`, sent at the start: dark wraparound sunglasses folded on a dirty van floor next to a stethoscope, dim yellow
  light, game-look photo mode, no faces.
* `confidentiality-ward.png`, sent the next morning by Viktor with "Thanks for waiting.": a man's back in a rolled-sleeve button-up shirt scrubbing
  his hands at a bucket in a warehouse, a door-table behind him with a blanket, dawn through broken windows, game-look photo mode.

Build: `text` + `image`, `place`, `squad` with a boss `cast` and `npc-react` (existing), `unseen` (new), `hostage` using one of the mod's copies
(new), a no-combat radius rule with a dwell timer (small: the squad's combat flag inside a `place`), `together`, `ride`, `history`.

Lines: see BOND_QUEST_LINES.md, Viktor V5

### V6. Corner (`viktor-corner`)

Gate: bond 10, V5 finished (`after`), `mq033_tarot` finished, none of his quests active. Any relationship.

Premise: one of the young Devils (a nameless fighter) keeps dropping his guard on the second round and nobody can tell him why. Viktor decides to
show him by getting in the ring himself, three rounds, no judges, no belt. He has not done it since the Grand Prix. He needs somebody in the corner
with a stool, a bottle and a towel, and the person he picks is V.

Stages:
1. `ask`: **call-in**. "Corner man. Stool, towel, water. Thursday night." `meet` at the hall `place` (the Watson hall where the Grand Prix was held,
   verify). Stood up: `no-corner`.
2. `wraps`: **dressing room**. `seat` on the bench (`together` seated, 5 game minutes). He holds out his hands and V wraps them (narrative, hard: no
   hand-wrap animation, closest is `gestures` on his side while V sits next to him). He talks about the second-place night and the one thing he
   has not said about it.
3. `rounds`: **corner man**. `post` for V at the corner `place` (within 3 m of the stool). Viktor's copy fights a younger `cast` boxer in three `bout`
   rounds (fists only, a handicap on the young man so it stays close). Between rounds, 60 s of `together` at the stool with talk tags: `breathe`,
   `jab`, `guard`, or `towel`. After round two Viktor has a cut over one eye (a face cue, `gestures`). V can throw in the towel at any time
   (`towel`), a real choice he reacts to.
4. `after`: **sit and patch**. Dressing room again. V holds the lamp while Viktor patches himself (words, hard: no procedure), and he hands V the
   runner-up medal and says what he thinks of it.

Talk:
* the corner as a thing a fighter picks, not a favour: "someone who'll tell me the truth about my feet"
* Jackie, by the save: how he used to say the corner is where you find out who your friends are
* second place and sleeping well: the clearest statement he makes in the whole arc
* what he would say to a younger V, and what he is proud of in this one
* (`towel`) fury for a full minute, then thanks, then more fury

Outcomes:
* `stood` (three rounds, +100): "You were Viktor's corner man for three rounds at the old hall, and he gave you his Grand Prix medal." `history`:
  permanent, he calls V "my corner".
* `towel` (V stopped it, +85): the same, with "V stopped the fight when it needed stopping and he has not forgiven it yet, which is how he says thanks."
* `walked` (V left early, +20), `no-corner` (-10).
* Rewards: the medal (`items`, a junk item renamed only in the image, verify the second place detail) and the image kept in V's chat thread.

Images (the top quest, five):
* `corner-wraps.png`: two hands wrapped in white tape resting on a bench, a stethoscope on the bench beside them, a locker door open behind,
  tungsten light, game-look photo mode.
* `corner-stool.png`, sent at round 1: the view from a boxing corner stool, a white towel on the ropes, the canvas and the far corner slightly
  out of focus, a bottle in a hand at the frame edge.
* `corner-ring.png`, sent at round 3: a ring from above, two fighters clinched under a hard lamp, an old man in the near corner standing at the
  ropes, game-look photo mode.
* `corner-lamp.png`, sent in `after`: a close shot of a man's dark brow with a taped cut under a work lamp, a gloved hand holding the lamp steady.
* `corner-medal.png`: a tarnished second-place medal on a faded ribbon on a palm, lights of the hall blurred behind it.

Build: `call-in`, `meet`, `bout` (new, Viktor's copy as a fighter, round timer, handicap and a stop rule), `post` at the corner, `seat`, `together`,
choice tags at timed stops, `gestures`, `items` (unverified), `image` x5, `history`.


His voice: measured and dry, a doctor's short questions, boxing metaphors only now and then, a joke only when the other person is calm. The game-placed Viktor stays in his clinic, so the copy's lines are only used away from it.

Pins: the meeting point, the Watson hall.

Lines: see BOND_QUEST_LINES.md, Viktor V6

### Viktor: scripted lines, holocalls and talk gaps

The scripted lines, the holocall scripts and the talk gaps (and the music and sound notes) of V1 to V6 are in [BOND_QUEST_LINES.md](BOND_QUEST_LINES.md), under Viktor Vektor, quest by quest.

### Viktor reaches out first

Channels go through the Phone Chat (text) or the mod's holocall. Each trigger respects the plot-safety gate. The LLM always knows: the bond level, the last topic of conversation, the trigger event and anything in V's state worth a doctor's eye.

| id | trigger | channel | opening line(s) | cooldown | the LLM knows |
|---|---|---|---|---|---|
| VR1 | After Jackie's death (`q005_heist` finished, a game day later) | text | Heard about Jackie. The door's open. No need to talk. | once | Jackie's loss, Viktor's own history with him, V's last words about it |
| VR2 | V comes out of a big fight with low health (a `battle` event, health under 25 percent) | holocall | You look bad on paper. Come by. Don't argue. | 3 game days | V's wounds, which fight, the last fix he did |
| VR3 | Bond level-up to 5 | text | Misty asked if you'd eat with us. I said you're busy. Were you? | once per level | Misty, the tarot, the shop |
| VR4 | Friday evening, after V1 | text | Card tonight at the old gym. Seat's free. | 7 game days | the gym, V1 result, any bet |
| VR5 | V changes cyberware (a `gear` or cyberware change event) | text | New chrome? Tell me how it sits before it tells you. | 5 game days | V's new implant, his opinion of its brand |
| VR6 | The first night V is awake past 3 AM game time | text | Some people can't sleep. I'm one of them. Tea's on. | 4 game days | V's insomnia, the hour, Viktor's own habits |
| VR7 | After the story moment where Viktor learns what the chip in V's head is doing (journal path to verify) | holocall | It hasn't gone away, has it. I looked at your scans again. Come see me. | once | what the chip is doing (as the game shows it), his limits ("I'm not an expert, I won't claim Militech's secrets") |
| VR8 | After V pays the 21,000 (`mq045_victor_debt`) | text | You paid the 21,000. Fastest I've ever been paid. Don't let it go to your head. | once | the debt story, how much V had left |

### Viktor hangouts

Rules for all five: accepting raises the bond by +6, completing the activity gives +2 to +8, each is repeatable with three variations, and none is a quest. Locations are in Little China (Watson) or the Glen (Heywood). Exact spots are captured in game later (verify each exists).

#### VH1. Auscultation Walk

* **Location:** the noodle alley under the elevated rail in Little China (verify). **Unlock:** bond 2.
* **Invitation (text):** "I have a stethoscope and a theory. Meet me at the noodle alley. Bring your ears."
* **Activity:** Viktor lends V the stethoscope. Three listening stops (`place`s): a humming neon box, a vending machine, a busker's amp. At each V says what is wrong with the hum (V's guess is a tag: `fine`, `fault`, `danger`) and he tells the truth. Score = correct guesses, +2 each, so +2 to +6 (+8 with the twist).
* **Twist:** a passer-by (`cast`) walks past with a limp. Viktor listens to the actuator across the street and asks V to stop him. V can talk him into a check (`npc-react`). If it works, +2 bonus.
* **Gap VH1.g1** after the second stop. **Asks:** "Which of the three worried you most, and why?" **Knows:** the stops, V's guesses so far. **Secret:** the vending machine is the one that is actually fine. **Wants:** V to name a reason, not a hunch. **Idle:** `ripperdoc_arms`. **Resumes on:** V names a stop. **Branches:** V's reason is repeated later as "your ear".
* **Variations:** (a) rain, the hums are masked and the scoring is harder, (b) the monorail platform instead of the alley, (c) the last stop is V's own heartbeat after a sprint, which he times.
* **Image (optional):** `ausc-stethoscope.png`, a stethoscope pressed to a humming vending machine, neon reflections.
* **Build:** `place` x3, `cast` limp pedestrian with `npc-react`, tags, `image`.

#### VH2. Fake Patients

* **Location:** the taco truck lot in the Glen (verify). **Unlock:** bond 3.
* **Invitation (text):** "Taco truck line in the Glen. Three people, one lie. Come hungry."
* **Activity:** three `cast` queuers each claim a symptom. V questions each (`archetype-talk`, ordinary NPC reactions) and chooses the faker by tag. +2 for the right pick, +2 for a good question, +2 for staying kind.
* **Twist:** the "faker" is the sickest of the three and hides it because he cannot pay. The "honest" one wants painkillers. V can pay for the real patient's treatment (`eddies`, 200 to 600), +2.
* **Gap VH2.g1** after the pick. **Asks:** "Who did you pick, and what made you doubt the other two?" **Knows:** the three claims, the true story. **Secret:** he knew in the first minute. **Wants:** V to say how he questioned. **Idle:** `lean`. **Resumes on:** V names a pick. **Branches:** a correct pick gets a dry "you'd make a bad doctor, you ask too many questions", a wrong one gets the twist explained gently.
* **Gap VH2.g2** at the reveal. **Asks:** "Do you tell him you know?" **Knows:** the twist. **Secret:** he has done it both ways and regrets both. **Wants:** V's instinct on dignity. **Idle:** `lean`. **Resumes on:** V decides. **Branches:** V's choice is remembered.
* **Variations:** (a) the faker is a runner dodging a debt, (b) all three are honest and the trap is trying to find a liar, (c) roles swapped, V plays patient and Viktor guesses.
* **Image:** none.
* **Build:** `cast` x3 with trait tags (the `scene` primitive from T2), `npc-react`, `eddies`.

#### VH3. Roadwork

* **Location:** the courtyard loop around Megabuilding H10 in Little China (verify). **Unlock:** bond 4.
* **Invitation (text):** "Roadwork at dawn. Five minutes to warm up, then I don't wait. Courtyard by H10."
* **Activity:** a jog loop of four `place` checkpoints, `together` within 5 m for 8 game minutes. At the end a sprint to the last place, first there wins. Completing the loop is +4, winning the sprint is +8.
* **Twist:** he calls "go" two seconds late and starts first. V can call him on it (a tag), +1.
* **Gap VH3.g1** at the half-way stop. **Asks:** "Quick answer. What do you run toward?" **Knows:** the loop, V's recent fights. **Secret:** he runs because he cannot box anymore. **Wants:** V to answer without thinking. **Idle:** `lean`. **Resumes on:** V answers or the timer. **Branches:** a quick answer earns a nod, a long one earns "later".
* **Variations:** (a) dusk lap with the lights on, (b) rain, (c) V leads and sets the pace.
* **Image:** none.
* **Build:** `party`, `together`, `place` x4, a foot `runner` with V chasing (the T3 variant).

#### VH4. Name That Beat

* **Location:** a rooftop in the Glen at dusk (verify). **Unlock:** bond 5.
* **Invitation (text):** "Rooftop in the Glen. I brought a radio and a bad opinion. Come tell me I'm wrong."
* **Activity:** V tunes the radio. A `radio` check reads the station and song. Viktor guesses the decade and the genre before the title shows, V guesses too. +2 per match, up to +6 over three songs.
* **Twist:** he has a walkout song he would pick. If one of the three is near his taste, he goes quiet and asks V to leave it on. Bonus +2.
* **Gap VH4.g1** after the second song. **Asks:** "Pick a walkout song for me. Defend it." **Knows:** the songs played so far. **Secret:** he already has one. **Wants:** V's argument. **Idle:** seat `lean` on the ledge. **Resumes on:** V proposes a song. **Branches:** V's pick is mentioned later if the radio plays it.
* **Variations:** (a) V picks the station, (b) V picks songs for three imaginary fighters, (c) no radio, V hums and he guesses.
* **Image:** `beat-rooftop.png`, a portable radio on a rooftop ledge at dusk, city haze, a hand at the dial.
* **Build:** `radio` check, `seat` on a ledge, `check` hour, `image`.

#### VH5. Brew and Haggle

* **Location:** the tea stall by the canal bridge in Little China (verify). **Unlock:** bond 6.
* **Invitation (text):** "Misty swears by a tea stall by the bridge. I swear it is overpriced. Come settle it."
* **Activity:** V haggles with the stall owner (`cast`, `eddies`, ordinary NPC reaction). The goal: price at or under 60 percent. Viktor sits and stays silent. Success +5, any deal +3.
* **Twist:** the owner is a boxing fan. If V mentions the Grand Prix in the haggle, he knocks off a further 10 percent, and Viktor looks at his tea.
* **Gap VH5.g1** after the deal. **Asks:** "What would you pay for a perfectly ordinary cup of tea?" **Knows:** the final price. **Secret:** he would pay twice, for the stall. **Wants:** V to value something unremarkable. **Idle:** seat `stool`. **Resumes on:** V names a price. **Branches:** a high price gets "good, you understand".
* **Variations:** (a) a different tea and a tasting, (b) closing time, rain, (c) Misty's copy joins and predicts what V will pick.
* **Image:** `brew-tea.png`, two paper cups of tea on a canal rail, steam, neon lanterns.
* **Build:** `cast`, `eddies`, `npc-react`, `seat`, `image`.

### Viktor's gifts

Item categories only (ids come from the separate research). Tiers are loved, liked, disliked.

| Tier | Categories | Reaction line | emotion | animation |
|---|---|---|---|---|
| Loved | old boxing memorabilia (gloves, programs, posters, fight tickets), vintage medical tools, a bottle of real medicinal spirits | Where did you find this? Put it down gently. I mean to keep it. | happy | generic_hold |
| Loved | a carefully repaired mechanical watch, a hand-written note | Somebody took care of this. I won't forget who. | nod | generic_hold |
| Liked | good tea or coffee, real food, clean practical tools | Practical. I like practical. Thanks. | nod | generic_front |
| Liked | incense or Misty's wares, a well-made bandage kit | Misty will want to know where you got this. | happy | generic_front |
| Disliked | showroom brand chrome and corporate logo items, cheap clone implants, fight-fixing tokens or betting slips | Take it back. I won't pretend. | no | generic_arms_crossed |
| Disliked | weapons gifted as "protection" | I treat what weapons do. I don't carry them. | disgust | generic_arms_crossed |

What Viktor gives V, by rarity, said when the pack hands the item over:

| Rarity | Gift | Line | emotion | animation |
|---|---|---|---|---|
| Common | a strip of painkillers and a roll of tape | Keep them in your pocket. Don't use them on a Tuesday. | nod | generic_front |
| Uncommon | a pair of hand wraps | Tight across the knuckles. Not the wrist. | emphatic | generic_front |
| Rare | a worn pair of sparring gloves | Old gloves hit harder than new ones. Don't ask me why. | happy | generic_hold |
| Epic | the Devils club jacket | Don't wear it where I'll be embarrassed. | shrug | generic_hold |
| Legendary (iconic) | the Grand Prix runner-up medal | Second place. It's lighter than you'd think. (the same item as V6, never given twice) | sad | generic_hold |

---

## 8. Jackie Welles

Canon anchors: a Heywood son of Mama Welles, a former Valentino who left the gang after a serious injury, a mercenary who dreams of Afterlife legend and big money. Misty is his
girlfriend (her Esoterica is in Little China, Viktor's clinic is behind it), Viktor is his ripperdoc and boxing mentor, T-Bug a working collaborator. He rode a bike at fifteen, reads
Hemingway, lifts weights as meditation, loves food (his mother's sopa de fideos), tequila (a sealed lucky bottle he keeps for a big win) and a vodka, lime and ginger beer drink he would
name after himself. He tells his plans out loud, makes a plan sound like an adventure and goes plain and protective when someone is in danger.

**The Heist framing (all six):**
* **All his quests happen before The Heist**, in Act 1, with one of the mod's own Jackie copies. The game then opens only Watson (Kabuki, Little China, Northside, the Arasaka
  Waterfront), so **no stage is ever set in Heywood**: no El Coyote Cojo, no Mama's place. Mama Welles is only a voice on his phone (his half of a call, never hers: the game-placed
  Mama only talks, and the pack never uses a copy of her). Places used: the Afterlife, Viktor's clinic, Misty's Esoterica, Kabuki Market, the Kabuki Metro, the Northside Maelstrom
  areas and a Northside pit.
* **Standard Jackie gate (SG)**, used by every quest below: `q001_01_victor` (Victor, Victor) and `q001_02_dex` (The Gig) finished (`verify` the titles), plus the new **`gate-plus`**
  field: `before: quests/main_quest/prologue/q005_heist` (The Heist not finished) and a story window that lets `q003`, `q004` or `q005` be active only when it is not V's tracked
  quest and no scene, dialogue or cutscene of it is running. Once The Heist is finished, no Jackie quest starts, and every one still open ends in its own `unfinished` ending.
  Plot-safety condition 4 (no scene, combat, game call) still applies.
* **Ladder 2, 2, 3, 4, 5, 6** (the owner lowered it on 29 Oct from 4, 4, 5, 6, 7, 8, with his quests in the same order): the prologue is short in game days, so each quest fits one evening and unlocks in order of bond, and the low gates are what make all six reachable before The Heist. The last quest is the night before.
* **Every quest has an `unfinished` ending** (bond +0), used when The Heist happens while the quest is open. Its memory line is read by nobody but V's own memory, and by Misty and
  Mama Welles through `memory-share` as talk only. The character never knows he will die. The dramatic irony is never spoken: his lines are written as if the future existed.
* His bike is the Arch Nazaré (`verify`), his own `her-car`. A stage that needs him on foot uses `vehicleBlocked`.

### JW1. Not Quite Mama's (`jackie-sopa-test`)

Gate: SG, bond 2, none of his quests active. Any relationship.

Premise: Jackie has not been home for a week and misses his mother's sopa de fideos. He can't go until the job is done, so he wants to find the nearest thing in Little China, one
noodle stall at a time, with V as the judge. It is the first time he lets V see that he is homesick.

Stages:
1. `ask`: **text and `meet`** at a Little China street `place` (the lane of noodle stalls near the Afterlife, `verify`), within 2 game hours.
2. `crawl`: **walk and sit, three stalls**. `party`, `together` at each stall for at least 8 game minutes, `seat` at the counter. At each he orders a bowl (narrative only), and V gives
   a rating (tags `one`, `two`, `three`). He compares each to Mama's with comic exactness, and goes quiet at the closest one.
3. `call`: **his own phone call**. Outside the best stall he calls Mama. V hears his half only. She asks if he has eaten, if V has eaten, if he has seen Misty. V can wait or step
   away (tags `stay`, `step-away`), and cannot hear her side. The game-placed Mama never speaks in the pack.
4. `verdict`: **talk and sit**. He picks the winner and says he'll bring her to try it "when things calm down". `seat` at the winning stall for 10 game minutes.

Talk:
* food as love and as a way of measuring home, never only a gag
* Hemingway, in one line: he likes how little the old man says about the sea
* small things about the street he grew up on, as warm detail without inventing relatives
* stall three is not as good, but it is hot, and that is what he picks for tonight

Outcomes:
* `verdict` (+40): "You and Jackie ate your way through Little China looking for a bowl like his mother's, and he called home from the best stall."
* `verdict` with `step-away` (+45, "you gave him his call").
* `incomplete` (+25), `stood-up` (-5).
* `unfinished` (+0): "You and Jackie were going to find a noodle stand that tasted like his mother's sopa de fideos. Then The Heist came, and you never did."
* Rewards: none.

Images:
* `sopa-stall.png`, sent at `verdict` with the caption "Number three. Don't tell Mama.": a steaming bowl on a Little China counter, neon kanji reflected in the broth, two sets of
  hands at the edge (one with gold-ringed knuckles), a hot-sauce bottle, game-look photo mode.

Build: `text`, `meet` at a `place`, `party` + `together` (new), `seat` (existing), a phone-half call (a `remote` line set from him, no holocall to the game's Mama), `image`.

Pins: the meeting point, the lane of noodle stalls in Little China.

Lines: see BOND_QUEST_LINES.md, Jackie JW1

### JW2. Sticky Fingers (`jackie-sticky-fingers`)

Gate: SG, bond 2, none of his quests active (it can run before or after JW1). Any relationship.

Premise: Jackie is showing V the new grips on his bike in the crowd at Kabuki Market, loudly, when a kid brushes past and is gone. Jackie reaches for his collar and the gold cross he
never takes off is not there. He doesn't say what it is to him, and he doesn't have to. He goes after the kid over the stalls.

Stages:
1. `show-off`: **talk and `meet`** at Kabuki Market (`place`, the east entrance), with his bike. He has V look at the grips. Tags: `admire`, `tease`. Both go on.
2. `lift`: **foot chase, `runner` on foot**. The pickpocket (a nameless young extra) runs a fixed route through the market: stalls, a stair, a rooftop walkway of the market's upper level,
   a back yard, ending at a fence's stall in Little China (`place`). V and Jackie follow on foot (`party`, Jackie runs with V and shouts). A vehicle is no use here. The kid stops when V is
   within 4 m at a dead end (the route has two of them), or when V calls out and the ordinary NPC rules say he freezes. If he reaches the fence's stall: `fenced`.
3. `catch`: **talk with the thief, `npc-react`**. If caught, Jackie lets him go with a lecture (`let-go`), the kid is scared into leaving (`scare`, the threats route, cower) or a brawl
   starts (`rough`). The kid is a nameless young extra with a stage note: cold, hungry, not a hardened thief.
4. `fenced` (branch): **buy it back**. The fence (a `cast` stall owner, ordinary vendor rules) has the cross on a velvet cloth. V can pay (200 to 600 eddies, the small "pay an NPC"
   flow), talk the price down, or lean on him (the threats route: cower or call the police, which raises heat). Jackie stands behind V and says nothing, which is how V knows.
5. `listen`: **sit** with the bike. Jackie puts the cross back on, then lets V sit on the bike for 5 game minutes. "Easy with the throttle. Listen to the engine first." (`seat` on a
   bike workspot, `verify`, else V stands beside it.)

Talk:
* the bike as proof a Heywood kid can build something, with technical affection and obvious exaggeration
* how a Valentino handles a thief, and how he handled himself at fifteen
* a laugh at himself for yelling in a market at a kid
* (`let-go`) a practical line to the kid about where to eat, which is Jackie all over
* about the cross: nothing, then one sentence that is not an explanation

Outcomes:
* `catch` with `let-go` (+55): "A kid lifted Jackie's gold cross at Kabuki Market, you chased him over the stalls, and Jackie let him go with a lecture and a meal."
* `catch` with `scare` (+45), `catch` with `rough` (+40), `fenced` and bought back (+40).
* `lost` (+10): the kid got away with it. Jackie says it's only a cross, and wears a plain cord. (Narrative only, his appearance does not change.)
* `unfinished` (+0): "Somebody took Jackie's gold cross at Kabuki Market and you went after it with him, and you never knew how it ended."
* Rewards: none.

Images:
* `sticky-walkway.png`, sent at `catch`: a rooftop walkway above Kabuki Market at dusk, neon signs, laundry lines, a small figure sprinting away with a trailing blur, two shadows
  behind, game-look photo mode.
* `sticky-cross.png`, sent at `listen`: a small gold cross on a chain in an open palm with a bike's handlebar grip behind it, workshop light, grease on the knuckles.

Build: `meet`, `runner` (new, on foot), `party`, `npc-react`, `place` (fixed route and dead ends), `cast` (fence), `eddies` pay-an-NPC (small), `heat`, `seat` on a bike (new, `verify`), `image`.

Pins: the meeting point, the east entrance of Kabuki Market.

Lines: see BOND_QUEST_LINES.md, Jackie JW2

### JW3. Come Home, Kid (`jackie-come-home`)

Gate: SG, bond 3, `q003_maelstrom` (The Pickup) finished (V knows Northside's Maelstrom), none of his quests active. Any relationship.

Premise: a neighbor from his old block texts Jackie: a teenage kid from his street was seen with Maelstrom recruiters in Northside, and by morning he will have signed on to something
he can't get out of. Jackie sees himself at that age and knows what it costs. He distrusts the Maelstrom, and says so, because the Valentinos at least have rules.

Stages:
1. `text`: **text and `meet`**. The text reaches Jackie, he calls V in. `meet` at the Afterlife steps within 1 game hour.
2. `drive`: **`ride`**. V drives Jackie to Northside, with his running commentary on the Valentinos and the Maelstrom, the clearest he gets on both. Destination: a Maelstrom yard in
   Northside (`place`, not the one from The Pickup, `verify`).
3. `yard`: **talk, stealth or fight, V's choice**. A `squad` of 5 Maelstrom, relaxed, with the kid (a `cast` extra, about 16, stage note: wants to be someone, scared) among them and a
   recruiter (the squad boss, talkable). A 6-minute clock: at minute 6 the kid is handed a job and a gun, and the stage fails (`signed`). Three approaches:
   * Jackie walks in and talks (`talk`, V covers him from a `post` at the gate): the recruiter and the kid react by the ordinary NPC rules, and the squad stays relaxed if the words are good
   * V goes `unseen` to the kid and leads him out (`unseen`)
   * V or Jackie start a fight (`loud`)
4. `out`: **escort on foot, then ride**. The kid follows V (a temporary follower like a recruit) to the car. `ride` to the Kabuki Metro station `place` (the Metro is the only way home,
   and no stage is ever set in Heywood).
5. `platform`: **talk**. Jackie puts the kid on the train, with one line about his mother.

Talk:
* a Valentino's code: religion, honor and the neighborhood as predictable rules, against the Maelstrom's chrome and appetite
* Jackie as the older brother the kid never had, clumsy and warm
* "you want a name? Get one the long way"
* afterwards he is quiet in the car, then talks about Misty, because it is the only good thing to talk about

Outcomes:
* `platform` after `talk` or `unseen` (+65): "You helped Jackie talk a kid from his old block out of the Maelstrom in Northside and put him on a train home."
* `platform` after `loud` (+50), `signed` (+20, "the kid went in, and Jackie took it hard for days", a 3-day note).
* `unfinished` (+0): "Jackie got a text about a kid from his old block, you went to Northside with him, and you never heard if the boy got home."
* Rewards: none. `memory-share`: Misty's game-placed copy (talk only) hears V and Jackie went.

Images:
* `come-home-yard.png`, sent at `yard`: a Maelstrom yard at night from a rooftop, a shrine of chrome parts under a floodlight, a small figure in a hoodie among taller silhouettes,
  game-look photo mode, long lens.
* `come-home-platform.png`, sent at `platform`: a Metro platform, a boy's back with a rucksack, a large hand with gold rings on his shoulder, train lights, game-look.

Build: `text`, `meet`, `ride`, `squad` (relaxed, boss talkable), `cast` with a stage note, `unseen`, `post`, `npc-react`, the recruit follower route for the kid, `image`, `memory-share`.

Pins: the meeting point, the steps of the Afterlife.

Lines: see BOND_QUEST_LINES.md, Jackie JW3

### JW4. Wraps (`jackie-wraps`)

Gate: SG, bond 4, none of his quests active. Any relationship. Needs an unarmed `fight` variant (`verify`).

Premise: Jackie lifts weights to meditate. Tonight he needs it more than usual, and he has decided to take a bout in a Northside pit, the way he used to with Viktor, because the
sparring there is real. He wants V in his corner. First the gym, then Viktor, then the ring.

Stages:
1. `lift`: **timed presence at a gym**. The `place` is the gym in V's megabuilding (Kabuki, `verify`) or a rooftop set with weights. `together` 15 game minutes. His copy lifts on a
   `workspot` (weights, `verify`). V is the spotter: a tag `spotted` when he asks. He doesn't want therapy, only company.
2. `clinic`: **visit Viktor**. Viktor's clinic behind Misty's Esoterica in Little China (`place`). Viktor (game-placed) wraps his hands and says what he thinks, talk only. Misty
   leans out of her shop to tease him (talk only).
3. `pit`: **a duel-like bout**. At the Northside pit `place` (an old warehouse in Northside, `verify`): a `cast` fighter (nameless) and a pit boss. A friendly unarmed bout in rounds of
   90 s. V can call the towel (tag `towel`) at any time, which Jackie hates. V can bet (`eddies`, 200 to 1,000). If Jackie falls under 25 percent health the engine stops the bout.
   Results: `won`, `lost`, `towel`.
4. `after`: **sit** on the pit's steps with ice, `together` 10 game minutes. Honest talk about Misty, about Valentino fights, about what lifting is for.

Talk:
* the weight room as a place to put problems without being talked at
* Viktor as the man who taught him to throw a punch and not to throw it at the wrong person
* in the pit, short real lines from a man who enjoys it too much, and then doesn't
* (`towel`) he is angry, then says thank you, and that nobody ever did that for him

Outcomes:
* `won` (+60): "You were Jackie's corner at a Northside pit and he won on his feet."
* `towel` (+50), `lost` (+40, "he lost, and he tells it with himself as the loser, which is the best kind"), `lift-only` (+25, V skipped the pit).
* `unfinished` (+0): "Jackie wrapped his hands for a fight at a Northside pit, and The Heist came before you saw the end."
* Reward: if `won` and V bet, the winnings (`eddies`).

Images:
* `wraps-hands.png`, sent at `clinic`: taped hands on a steel clinic tray, a blue examination lamp, a rack of tools at the edge, game-look photo mode.
* `wraps-ring.png`, sent at `pit`: a rope ring in a warehouse, bare bulbs, a crowd as silhouettes, a man in the corner seen from behind with a gold cross on his neck.

Build: `together` at a `place`, `workspot` weights on the copy (`verify`), `meet`, `cast` fighters, `fight` unarmed with a stop at 25 percent (new, `bout`), `eddies` bet, `seat`,
`image`. Hard: no new fight animations. If an unarmed copy fight can't be made safe, the pit becomes a talk-and-bet scene with the ring as the setting and the result chosen by the
pack's data.

Lines: see BOND_QUEST_LINES.md, Jackie JW4

### JW5. The Drink with My Name (`jackie-drink`)

Gate: SG, bond 5, `q004_braindance` (The Information) finished, none of his quests active. Any relationship.

Premise: Jackie wants to rehearse the entrance he will make to the Afterlife when he is a legend. He wants a photo of it and a drink on the menu with his name. He cannot stop planning for
something that has not happened, and he asks V to co-write it.

Stages:
1. `meet`: **meet** at the Afterlife's front door (Little China `place`) in 1 game hour, night.
2. `entrance`: **walk, three checkpoints**. The door, the stairs to the booths, the bar (`place` points). `together`. He walks in slow, chin up, and V "plays the crowd" (tags `cheer`,
   `heckle`). Three `cast` regulars at the bar (nameless mercs) react by the ordinary NPC rules: one tells him to sit down, one laughs, one half-recognizes him from a job in Kabuki.
3. `photo`: **photo moment**. V frames the shot (a real photo-mode shot is not detectable, so a tag `got-it` closes the stage). The prepared `image` is the shot he gets.
4. `drink`: **talk and order**. At the bar he asks Claire (the game-placed bartender, talk only) what goes in a legend's drink. He gives his recipe (vodka over ice, lime, ginger
   beer) and fumbles the sentimental flourish. V picks one (tags `twist`, `salt`, `float`, `plain`). The drinks they order are two plain ones, and the name goes on a coaster.

Talk:
* the dream of recognition said out loud and honestly: it's not for the money, it's for the people he would bring
* a laugh at the pompous walk, a sincere flash at the booth where the fixers sit
* "a legend should be lived first," which came to him and he likes
* Misty's opinion of his plans, which she delivers with raised eyebrows

Outcomes:
* `drink` with a flourish (+60): "You helped Jackie plan his Afterlife entrance and name his drink, and you picked the flourish." `history`: he keeps the name for a future menu in talk.
* `drink` with `plain` (+45), `entrance` only (+35).
* `unfinished` (+0): "You and Jackie rehearsed his entrance to the Afterlife and named a drink you never ordered. Then The Heist came."
* Rewards: none.

Images:
* `drink-entrance.png`, sent at `photo` with "Frame it": the Afterlife's front door at night, red and gold neon on wet pavement, a broad-shouldered man in a dark jacket seen from
  behind with one arm raised like a champion, game-look photo mode.
* `drink-coaster.png`, sent at `drink`: a bar coaster with a handwritten recipe "VODKA / LIME / GINGER BEER / ???", two glasses with ice and a lime wedge, a gold cross dangling off one rim.

Build: `meet`, `place` with inner points, `together`, `cast` (regulars with stage notes), `npc-react`, `image`, `history`. The bartender is game-placed and talk only.

Pins: the meeting point, the front door of the Afterlife.

Lines: see BOND_QUEST_LINES.md, Jackie JW5

### JW6. The Bottle (`jackie-the-bottle`)

Gate: SG, bond 6, `q004_braindance` finished, none of his quests active. Any relationship. The most personal Jackie quest. The pack says "tomorrow" only if the game clock agrees
with the story window, otherwise "soon".

Premise: tomorrow is the big job. Jackie has a sealed lucky bottle he keeps for the day he makes it big, and tonight he doesn't open it. He has three things to do before he sleeps:
see Misty, call his mother, and sit on a roof with V. He will never say what he is afraid of, because he isn't afraid. He is excited.

Stages:
1. `ask`: **text and `meet`** at Misty's Esoterica in Little China (`place`), 21:00.
2. `shop`: **talk at a shop**. Misty (game-placed, talk only) serves tea and gives Jackie a good-luck pendant from her shelf, which he hangs on his bike. She pulls a card for him,
   looks at it for a long time and puts it face down. V can ask, and she says she was only checking the deck. Jackie waves it away.
3. `call`: **his phone call**. Outside, he calls Mama. V hears only his half: short, loud, loving, with a bad lie about the plan. V can step away (`step-away`) or stay (`stay`).
4. `roof`: **sit together on a Little China rooftop** (`place`, a roof with a view of the bay, `verify`). `seat` on a ground workspot, `together` 20 game minutes, `check` on the hour
   (night). The bottle stands unopened between them. He lays out the plan: the Afterlife, a house, a good lock on his mother's door. He asks V to promise they will open it together
   when they have won. V's answer is a tag: `promise`, `maybe`.
5. `home`: **walk back**. He walks V to the corner of V's lane. "See you at Dex's," or whatever the story needs. He doesn't hug V. He does.

Talk:
* Hemingway, one more line, the one about courage he remembers wrongly
* the bottle as proof of faith in the future, and a joke about drinking it from a boot
* Misty's silence and how he chooses to read it
* the promise, said as if it were plain, which is the cruelest thing about the quest and is never marked
* (`maybe`) he accepts it with a grin and says he'll hold V to it anyway

Outcomes:
* `home` with `promise` (+90): "The night before The Heist you sat on a roof in Little China with Jackie and a bottle he wouldn't open, and you promised to drink it with him when it was over."
* `home` with `maybe` (+80), `roof` skipped (+40).
* `unfinished` (+0), used when The Heist comes before the roof: "Jackie asked you to a roof in Little China, and you were going to sit with him, and then you had to go."
* Lasting: `history`, permanent in V's memory, and `memory-share` to Misty and Mama Welles as talk only (they remember what V says about this night, not that the mod ran it).
* Rewards: none.

Images:
* `bottle-roof.png`, sent at `roof`: two pairs of boots on a Little China rooftop ledge, a dark sealed bottle with a faded label standing between them, neon haze, the bay beyond,
  game-look photo mode, no faces.
* `bottle-misty.png`, sent at `shop`: a cluttered shop counter lit by candles, incense smoke, two small cups, one tarot card face down, a pendant on a cord, game-look.

Build: `text`, `meet`, `place`, `seat` ground (new workspot), `together`, `check` on the hour, phone-half call (`remote`), `image`, `history`, `memory-share`, `gate-plus`.

Pins: the meeting point, Misty's Esoterica in Little China.

Lines: see BOND_QUEST_LINES.md, Jackie JW6

### Jackie: scripted lines, holocalls and talk gaps

The scripted lines, the holocall scripts and the talk gaps (and the music and sound notes) of JW1 to JW6 are in [BOND_QUEST_LINES.md](BOND_QUEST_LINES.md), under Jackie Welles, quest by quest.

### Jackie reaches out first (Act 1 only: all before The Heist, none in Heywood)

All gated by the standard Jackie gate (SG). Channel as listed. Cooldown is per trigger and none may fire while a scene is running.

| id | Trigger | Channel | Opening line(s) | Cooldown | What the LLM knows when V answers |
|---|---|---|---|---|---|
| JWR.01 | Bond level-up 2 to 6 | text | "Hey, choom. Level up! That's friendship, hermano. Real. Let's celebrate." | 1 per level | the new level title, he is excited, he suggests a hangout |
| JWR.02 | 12:00 to 14:00 and V has not eaten (a `check` on the hour only) | text | "Noon and I'm starving. Where are you? Let's eat. I'm buying. ... Okay, you're buying." | 24 game hours | the hour, food as love, he knows no place by name except Little China |
| JWR.03 | After `q003_maelstrom` (The Pickup) | holocall | "That job. The Maelstrom. Hermano, I've seen that crowd. Be careful, yeah?" | once | The Pickup result, his distrust of the Maelstrom, the Valentino code |
| JWR.04 | Evening 19:00 to 22:00 | text | "Misty's making tea. Come by. Bring nothing. Or bring tacos." | 36 game hours | Misty's shop in Little China, Viktor's clinic behind it, his plans |
| JWR.05 | After a Jackie hangout | text | "That was fun! We do that again. Pick the next one." | 1 per hangout | the hangout just done, a joke from it, the next hangout he suggests |
| JWR.06 | V's eddies below a threshold (eddies record) | text | "Short on cash? I'm good for a loan. Pay me back in noodles." | 48 game hours | V's balance band, the Eddies loan flow, Jackie cares but jokes |
| JWR.07 | V near the Afterlife for 5 game minutes | holocall | "Look at the Afterlife. One day they'll chant my name. Tell me I'm not crazy." | 24 game hours | the dream of legend, the Afterlife, Rogue's booth, no mention of any outcome |

### Jackie hangouts (Watson only: Kabuki except the market, Northside, Arasaka Waterfront. Act 1 only)

Every Jackie hangout also carries the SG gate and an `unfinished` end: if The Heist happens during one, it simply ends and its memory line is "You and Jackie were doing something light, and it ended there."

#### JWH1. Slowest Wins (Northside back roads), bond 2

* **Invitation** (text): "Race. But backwards. Last one to the finish wins. No stopping, no putting a foot down. I'll beat you at going slow."
* **Activity**: **reversed `race`**. Jackie rides his bike (`her-car` copy) and V drives any vehicle to a finish `place` on a Northside waterfront lot. The slowest to arrive wins, but a slow watch (1 Hz, only while this runs) fails anyone who stops moving for 5 seconds.
* **Twist**: Jackie keeps waving at strangers and "accidentally" speeds up when he sees a food truck.
* **Gap JWH1.g1** at the start.
  * **asks** `JWH1.g1.ask`, Jackie (copy), question, jackie_hips: "Rules are simple. But tell me, hermano, who's the better slow driver, you or me?"
  * **knows** the rules, the finish, the 5-second rule, the route through Northside back roads.
  * **secret** none, he is just playful.
  * **wants** the race.
  * **idle** `lean` on the bike.
  * **resumes on** V starting the car.
  * **branches** V's claim sets his banter.
* **Bond**: +6 accept, +3 finish, +5 win.
* **Variations**: (1) night, empty roads. (2) a rain run. (3) with a cast pedestrian crowd at a crossing.
* **Image**: none.
* **Build**: `race` (reversed), `her-car` (his bike), a slow watch, `check` (hour).

#### JWH2. Gone Fishing (Arasaka Waterfront, a pier), bond 2

* **Invitation** (text): "Pier. Bring patience. I brought a line and a bad attitude."
* **Activity**: **timed presence, `together` 20 game minutes on the pier**, with a `check` of the hour and weather. The "catch" is a data roll: dawn and dusk give better odds. Results are small gags (a boot, a shard, a rusted can, a real fish at best). Items are narrative only, with an `image` for rare ones.
* **Twist**: a gonk (`cast`, street) asks to share the spot, bets Jackie he'll catch more, and loses.
* **Gap JWH2.g1** after the first ten minutes.
  * **asks** `JWH2.g1.ask`, Jackie (copy), question, jackie: "Tell me something good that's going to happen to you this year. Make it up if you have to."
  * **knows** the pier, a quiet time, the catch so far, the gonk.
  * **secret** that fishing makes him think of his mother.
  * **wants** V to talk about the future.
  * **idle** `lean` on the rail.
  * **resumes on** V's reply or the 20-minute timer.
  * **branches** a bold answer gets a laugh. A modest one gets a nod.
* **Bond**: +6 accept, +3 stay the full time, +5 for a "real" catch.
* **Variations**: (1) dawn. (2) night with a lantern. (3) a drizzle that gives only junk.
* **Image**: 1, `gone-fishing.png`, V's own shot: two lines over a pier rail at dusk, a lantern, cargo cranes far off.
* **Build**: `together`, `check` (hour, weather), `cast`, `image`.

#### JWH3. Salsa for Beginners (Kabuki, a corner club, verify), bond 3

* **Invitation** (text): "Dance lesson. Tonight. You're terrible, I'm free. Kabuki, ten."
* **Activity**: **dance lesson, `workspot` and `together`**. Jackie dances (`jackie_hips`, or a dance workspot "(verify)") at a club `place`. He names three moves over 6 game minutes. V says each back as a tag (`step`, `turn`, `dip`). A crowd (`cast`, 4) forms and claps if V keeps up.
* **Twist**: a stranger asks Jackie to dance, takes the lead, and Jackie goes red.
* **Gap JWH3.g1** after the second move.
  * **asks** `JWH3.g1.ask`, Jackie (copy), question, jackie_hips: "Can you feel the beat? No? Close your eyes. What does it sound like to you?"
  * **knows** the club, the stranger, V has missed one move.
  * **secret** that dancing makes him feel closest to his mother.
  * **wants** V to try.
  * **idle** `jackie_hips`.
  * **resumes on** V's reply.
  * **branches** a poetic answer makes him laugh. A flat one earns a lesson.
* **Bond**: +6 accept, +4 for staying through three moves.
* **Variations**: (1) a rooftop dance. (2) a quiet bar with only a radio. (3) a street corner at dawn.
* **Image**: none.
* **Build**: `workspot` (dance, `verify`), `together`, `cast`, `gestures`.

#### JWH4. Grease Monkeys (Kabuki, a back-alley garage, verify), bond 4

* **Invitation** (text): "My bike is coughing. Come hold the light and help me listen. You'll learn something."
* **Activity**: **diagnose by ear**. Jackie works on the bike (an idle workspot, "fixing the bike"). V stays within 2 m for 10 game minutes. He revs it three times. After each, V names a cause (tags `fuel`, `plug`, `air`). A data roll decides the real one. A right guess earns a thumbs up.
* **Twist**: the bike backfires once, startling a pigeon flock (an ambient one-shot, "verify").
* **Gap JWH4.g1** after the second rev.
  * **asks** `JWH4.g1.ask`, Jackie (copy), question, jackie: "What does it sound like to you? And don't say 'broken'."
  * **knows** the three causes, the rev results, V is close.
  * **secret** that he talks to the bike when no one is listening.
  * **wants** V's guess.
  * **idle** a repair workspot "(verify)", else `lean`.
  * **resumes on** V's tag.
  * **branches** right -> "Mechanic's ear." Wrong -> "Close. Almost."
* **Bond**: +6 accept, +4 stay, +6 if V guesses right.
* **Variations**: (1) a flat tire. (2) a chain problem. (3) a mystery rattle (no right answer, he laughs).
* **Image**: 1, `grease-monkeys.png`, V's own shot: a bike on a lift, a work lamp, a hand holding a spark plug up to the light.
* **Build**: `together` (2 m), a repair `workspot` (verify), tag picks, `image`.

#### JWH5. Constellations of Northside (Northside, a rooftop), bond 5

* **Invitation** (text): "Rooftop. Northside. Bring a jacket. I'm naming stars."
* **Activity**: **name constellations**. `seat` on a rooftop, `together` 15 game minutes, `check` of the weather and the hour. Jackie invents three constellations (The Big Taco, The Wrench, Mama's Pot). V invents one. If the sky is smoggy, he does "smog shapes" instead.
* **Twist**: a drone flies across the sky and Jackie names it a new star "The Delivery".
* **Gap JWH5.g1** after V's constellation.
  * **asks** `JWH5.g1.ask`, Jackie (copy), question, jackie: "What's yours called? And what's the story? There's always a story."
  * **knows** V's invention, the sky, the drone.
  * **secret** that he made one for Misty and won't say.
  * **wants** V's story.
  * **idle** `stool`, sitting on the roof's edge.
  * **resumes on** V's reply.
  * **branches** V's name is saved as a `history` line in his talk.
* **Bond**: +6 accept, +4 stay, +6 for a named constellation.
* **Variations**: (1) smog. (2) clear and cold. (3) fireworks from a festival.
* **Image**: 1, `constellations.png`, V's own shot: two silhouettes on a roof edge under a smoggy sky with a few bright stars, neon haze at the horizon.
* **Build**: `seat` ground, `together`, `check` (weather, hour), `history`, `image`.

### Jackie's gifts

* **Loved**: tequila or good spirits, hearty street food (tacos, noodles, tamales), motorcycle parts, a worn paperback (a Hemingway if the game has one, else any novel), gold chains and crosses.
* **Liked**: boxing gloves or wraps, a good jacket, a cigar, a decent energy drink, hot sauce.
* **Disliked**: Maelstrom or gang-brand items he distrusts, Arasaka goods, fake gold, anything that insults his mother's cooking.

| id | tier | speaker | line | emotion | animation |
|---|---|---|---|---|---|
| JWG.loved | loved | Jackie (copy) | Hermano! For me? You know me. Give it here. | happy | jackie_hips |
| JWG.liked | liked | Jackie (copy) | Nice! Not bad at all. Thanks, choom. | nod | jackie |
| JWG.disliked | disliked | Jackie (copy) | Uh... no. I don't want that near me. Sorry. | disgust | jackie |
| JWG.give.common | common | Jackie (copy) | Here. A taco. It's the thought. | happy | jackie |
| JWG.give.uncommon | uncommon | Jackie (copy) | Take this wrap. It brought me luck once. | nod | jackie |
| JWG.give.rare | rare | Jackie (copy) | A good bottle. We drink it when we win. | happy | jackie_hips |
| JWG.give.epic | epic | Jackie (copy) | A part from my bike. I want you to have it. | emphatic | jackie |
| JWG.give.legendary | legendary | Jackie (copy) | The key to my bike. Take her out for a night. That's trust. | sad | jackie |

---

## 9. Rogue Amendiares

Canon anchors: Queen of the fixers and owner of the Afterlife, once a solo in the old Night City mercenary scene, Johnny's former partner and lover, pragmatic, tough and a little tired.
She treats help as work with a price, plans around reach, backup and extraction, dislikes theatrical promises and refuses questions that are not the job. Nix, Claire, Emmerick and
Weyland are the Afterlife's working world, Nancy and her son Dan are old acquaintances, Panam is a capable but difficult working relationship. Her car is the Quadra Type-66
(`her-car`). Her three arcs with V (Chippin' In, Smack My Bitch Up, Blistering Love) are behind her, so no quest here is a drive-in date or a night out for a lead. Ladder: 3, 4, 5, 6, 8, 10.

Shared gate: `sq031_rogue` (Chippin' In) and `sq031_smack_my_bitch_up` finished, from R3 on also `sq031_cinema` (Blistering Love, see the summary: it may be missable), and no `q103`,
`sq031` or `q115` quest active. Rogue exists as a mod copy at the Afterlife or as a visitor. The game-placed Rogue only talks.

### R1. Terms (`rogue-terms`)

Gate: bond 3, the shared gate (without `sq031_cinema`). Any relationship. Eddies on.

Premise: Rogue has a sealed note she cannot send through anyone she employs, and she will not ask V as a friend. She hires V, with a price, and makes V negotiate it. She respects
people who do. The note goes to someone she has not spoken to in years.

Stages:
1. `terms`: **negotiation by talk, with her**. At the Afterlife's private booth upstairs (`meet` at a `place`) she names a fee. V can take it (`take`), push for more (`push`, she meets it
   if the argument is good), or refuse payment as a favour (`free`, she says that is not how it works and sets a smaller fee anyway). The tag changes the `eddies` reward (300 to 1,200).
2. `errand`: **calm errand**. V goes to a Kabuki noodle stall (`place`) where a `cast` extra waits (an old mercenary type, nameless, stage note: wary, owed an apology, has not forgiven).
   V gives him the sealed note (`items`, narrative if the item system refuses). His reaction follows the ordinary NPC rules: reads it and laughs, reads it and leaves, refuses it.
3. `twist`: **talk**. The old merc tells V what Rogue never told: the note is a bar tab, a drink owed from a night they both got out alive. He hands V a coaster for her (narrative) or a
   cold one-word reply.
4. `report`: **talk** at the Afterlife. Rogue wants one word from V, not a speech. She reads the coaster and does not smile.

Talk:
* a price quoted like an opening bid, and a quick sense of whether V can haggle
* "I'm not asking, I'm hiring," and then, much later in the quest, what she is actually asking
* the old merc as someone she would have been, and was, and isn't
* "it's a bar tab," said without a joke, which makes it the joke

Outcomes:
* `report` (+40): "Rogue hired you for a small job and you carried a note to an old solo in Kabuki. It was a bar tab. He answered with a coaster." Reward: the fee (`eddies`).
* `report` with `push` (+45, "you argued the fee up and she liked it").
* `torn` (+25, the old merc refused it), `free` (+35), `stood-up` (-5).
* `history`: she brings up "the tab" when old debts come up.

Images:
* `terms-envelope.png`, sent at `report`: a plain white envelope on a lacquered booth table in the Afterlife, a half-rolled bill beside it, red neon, a glass with a thumbprint.

Build: `meet` at a `place`, `eddies` (existing, a hired-job flow), `items` (unverified), `cast` with a stage note (new, small), `npc-react`, `image`, `history`.

Pins: the meeting point, the Afterlife, for the private booth upstairs.

Lines: see BOND_QUEST_LINES.md, Rogue R1

### R2. Hiring Day (`rogue-hiring-day`)

Gate: bond 4, the shared gate (without `sq031_cinema`), none of her quests active. Any relationship.

Premise: Rogue has a client job she cannot staff herself and three people on her list. She won't hire on charm. She trusts V's read of people because V doesn't care about the
Afterlife's pecking order. She wants V in the booth and quiet unless asked.

Stages:
1. `seat`: **`meet` at the Afterlife** (the private booth upstairs, `place`), 14:00. She briefs the job in two sentences: a courier escort, three days, no questions.
2. `interviews`: **three interviews, `cast` and `archetype-talk`**. Three `cast` extras arrive in order: a loud solo with a wall of references, a quiet netrunner with covered hands, a
   polite ex-corporate security man. Each has a stage note: one is reliable, one is a glory hound who will walk, one is an informant for a rival of the client. V can ask two questions
   each (the extras answer by the ordinary NPC route with the stage note). Rogue watches and says little.
3. `choice`: **talk**. Rogue asks V who gets the job. Tags: `A`, `B`, `C`, `none` (-> `none`).
4. `result`: **`text` the next game day**. Her fixed line reports how the job went, according to the hidden truth of the pick: delivered, walked, sold out.

Talk:
* the candidates as people, not résumés, with Rogue pulling out the one detail V missed
* "what did he do with his hands" as a question she wants answered
* the cost of a wrong hire in the Afterlife's world, said flat
* (`bad-hire`) a lesson, not a lecture: "now you know what it looks like"

Outcomes:
* `good-hire` (+55): "You helped Rogue pick the right solo for a courier escort in the Afterlife booth, and the job went as it should." Reward: 500 eddies from the client's fee (`eddies` gift via her).
* `bad-hire` (+35, "you picked the wrong one, and she told you what she would have looked for").
* `none` (+30, "you said none of them, and she did it herself, and it went fine").
* `unseated` (-5).

Images:
* `hiring-booth.png`, sent at `result`: the upstairs booth at the Afterlife, three empty chairs facing a table, three folders fanned across it, a glass untouched, a red lamp,
  game-look photo mode.

Build: `meet`, `cast` with a stage note per extra (new), `archetype-talk`, `text`, `eddies` gift, `image`.

Pins: the meeting point, the Afterlife, for the private booth upstairs.

Lines: see BOND_QUEST_LINES.md, Rogue R2

### R3. Four Questions (`rogue-four-questions`)

Gate: bond 5, the full shared gate, none of her quests active. Any relationship.

Premise: a nervous corporate accountant (nameless) wants out of a subsidiary and is hiding in a Northside drop house. Rogue's method is four questions: reach, backup, extraction,
and what defends the target. She wants V to do the extraction on foot with her voice in V's ear, the way she used to run people.

Stages:
1. `brief`: **`meet`** at the Afterlife. She sits in the booth (`post`, she stays there) and talks V through the four questions over a napkin map. Tags: V takes the job (`in`), V argues for
   a car (`car`, she refuses: "cars get seen"), V says no (`no`).
2. `recon`: **walk and `check`**. V goes to the drop house `place` in Northside. Her `remote` lines ask the four questions at four spots, and V's answers (a tag per spot) pick one of
   three routes back: alley (short, patrolled), rooftops (long, empty), canal road (open to vehicles).
3. `extract`: **escort with `unseen`**. The accountant (a `cast` extra) follows V at walking pace and cowers if shots are fired. A `squad` of 6 contractors patrols the three routes
   on different timers (the pack gives each route its windows). V must reach the Afterlife's side door `place` with the client alive:
   * unseen all the way: `clean`
   * seen once, a fight, client alive: `loud`
   * client dead: `lost-client`
4. `door`: **handover**. The client goes in. Rogue pays, and tells V the fifth question: "who will miss you?" She says it as a rule.

Talk:
* clipped, plain instructions with no theatre
* the four questions as an old habit, the fifth as a new one
* the accountant as the person she is trying not to become, and the difference between a client and a person
* her dislike of heroes, told through the dead ones

Outcomes:
* `clean` (+60): "You got a nervous accountant out of Northside unseen, on a route Rogue's four questions picked." Reward: 1,500 eddies (`eddies` gift).
* `loud` (+45), `lost-client` (+10, "you brought back the story but not the man, and she did not blame you").
* `no` (+0), `car` (+30, V went by car anyway and she said nothing).

Images:
* `four-questions-napkin.png`, sent at `brief`: a Night City street map drawn on a bar napkin, three routes in three pens, a dark ring from a glass at the corner, a hand with a pen at the
  edge, game-look photo mode.
* `four-questions-door.png`, sent at `door`: the Afterlife's side door at 4 a.m., a figure in an overcoat slipping in, red neon, rain on the pavement.

Build: `meet`, `post` + `remote`, `cast` follower with a stage note, `squad` on three route timers (new: patrol windows), `unseen`, `place`, `eddies`, `image`.

Pins: the meeting point, the Afterlife.

Lines: see BOND_QUEST_LINES.md, Rogue R3

### R4. Say Left (`rogue-say-left`)

Gate: bond 6, the full shared gate, none of her quests active. Any relationship.

Premise: Rogue is almost never a passenger. She asks V to drive her car, for no reason she will give, and to follow her voice only: no map, no destination. She has not been driven by
someone she trusted in years. She directs V through places the city has changed.

Stages:
1. `keys`: **`her-car` handover**. At the Afterlife's curb she gives V the keys to the Quadra Type-66 (V drives, she sits beside). A real act of trust, which she downplays.
2. `route`: **`ride` with a hidden route**. Five unannounced `place` checkpoints. She says "left" or "next" or "stop" at fixed junctions, using in-car lines at each checkpoint. V may
   ignore her (she says "I said left" and re-routes), but the quiet pace is the point. About 25 game minutes. Heat must stay zero or she asks V to pull over.
3. `rail`: **stand at a rail, `check` of the weather**. At "stop" they are at a lot above the water on the Watson waterfront (`place`, near the Kabuki container yard, `verify`). The car
   radio stays off. A `check` reads the weather and the hour, and her next line reacts to it (rain: she lets V stand in it, clear: she counts the stars the haze lets through). They stand
   at the rail (`workspot` lean) for 5 game minutes.
4. `drive-back`: **chauffeur**. She takes the wheel and drives V home (`chauffeur`).

Talk:
* what the city used to be, in short, accurate sentences with no nostalgia
* how Johnny drove, told as a complaint
* her car as the one thing she still maintains herself
* the first thing she says about growing old: "I notice the doors now"
* if V ignores a turn, dry: "left means left"

Outcomes:
* `drive-back` (+55): "You drove Rogue's Type-66 where she told you to, and she stood at the water for one song and said nothing."
* `short` (+25, V pulled out early or the heat rose).
* Reward: none. `history`: she calls the drive "left".

Images:
* `say-left-dash.png`, sent mid-route: the Type-66's dashboard at night, an old analog gauge cluster, a dim green radio display, a woman's hand on the passenger window frame, rain on the glass.
* `say-left-water.png`, sent at `rail`: a concrete rail above dark water, the lights of the Kabuki yard cranes beyond, a coat sleeve resting on the rail.

Build: `her-car`, `ride` hidden route (new variant: no marker, checkpoint lines), `place` x6, `check` (weather, hour), `workspot` lean (new), `chauffeur`, `heat`, `image`.

Pins: the meeting point, the curb at the Afterlife where she hands over the keys.

Lines: see BOND_QUEST_LINES.md, Rogue R4

### R5. Who's Listening (`rogue-whos-listening`)

Gate: bond 8, the full shared gate, none of her quests active. Any relationship.

Premise: Rogue is hiding a client at a Kabuki capsule hotel for one night, and her people at the Afterlife are clean. Someone told the other side where the client sleeps. It is one of
the three hotel staff, and she can't ask anyone she pays. She asks V to find out before they come.

Stages:
1. `call-in`: **she calls V**. "Kabuki. Capsule hotel. Wear nothing you'd miss." `meet` at the hotel (`place`, a capsule hotel in Kabuki, `verify`).
2. `lobby`: **watch**. V checks in. Three staff `cast` extras (a night clerk, a cleaner, a bellhop, each with a stage note) go about their routine. One, chosen from the pack's seed, will
   step out and make a call within 25 game minutes. A slow watch (1 Hz, only while this stage waits) records which one leaves their post. Rogue is at a `post` in the corridor with the
   client behind her door.
3. `catch`: **talk and `npc-react`**. If V reaches the leaker first (within 5 m before the call goes out), V can talk them down (the ordinary NPC rules: confess, run or fight) or tell
   Rogue. If V misses it, the call goes out and a `squad` of 4 arrives by car in 4 game minutes, a short fight in the lobby and the corridor (`fight` from her `post`).
4. `dawn`: **talk**. The client leaves in a car (a `cast` driver). Rogue asks V what V would have done if the leak had been Panam, or Nix, or one of her own. A real question.

Talk:
* a fixer's paranoia as a professional skill, not a flaw
* "it's never the one you hate"
* the leaker as a person she half understands, since the pay is bad
* (`miss`) she takes the blame and doesn't let V give it away

Outcomes:
* `caught` (+75): "You found the leak in a Kabuki capsule hotel before the other side arrived. Rogue's client left at dawn." Reward: 2,000 eddies (`eddies` gift via her).
* `fought` (+55, "you found out too late, and you and Rogue held the corridor").
* `lost-client` (+15).
* `memory-share`: the Afterlife's game-placed staff (talk only) know V "was useful".

Images:
* `listening-lobby.png`, sent at `lobby`: a capsule hotel lobby at night, a front desk with a lit sign, a clerk with a phone half-hidden under the counter, a pale tube light, game-look.
* `listening-dawn.png`, sent at `dawn`: a Kabuki street at dawn, a black sedan pulling away, a woman in a long coat on the curb with her hands in her pockets.

Build: `call-in` (new), `meet`, `cast` x3 with stage notes (new), a slow watch of who left the post (new, small, 1 Hz only while the stage waits), `post` + `fight`, `squad` with a car,
`npc-react`, `eddies`, `memory-share`, `image`.

Pins: the meeting point, the capsule hotel in Kabuki.

Lines: see BOND_QUEST_LINES.md, Rogue R5

### R6. What I Never Said (`rogue-never-said`)

Gate: bond 10, the full shared gate, `rogue-whos-listening` finished (`after`), none of her quests active. Johnny must still be in V's head (the system gate already guards the
endings). Any relationship.

Premise: Rogue knows who is in V's head. She has never said to him what she wants to say. She asks V to meet her at 3 a.m. at the place where nobody knows who she is: an all-night
laundromat in Little China, where she does her own washing. She says it out loud while the machines turn. She asks V not to answer for him. He answers anyway, in V's ear.

Stages:
1. `ask`: **`meet`** at the laundromat (`place`, an all-night laundromat in Little China, `verify`), 03:00. "Bring nothing. I've got the soap."
2. `spin`: **sit together**. `seat` on the plastic chairs, `together` 20 game minutes, `check` on the hour. She folds, and keeps folding, and says what she has to say. Tags: V relays it
   (`relay`: V says it back in chat, in V's own words), or lets it lie (`lie`).
3. `reply`: **`johnny-voice` answer**. Johnny answers privately through `johnny-voice`, in V's ear only. She doesn't hear it. V decides whether to tell her what he said (`tell`, `keep`).
4. `walk-out`: **walk**. She walks V to the corner with her bag. She does not drive V. She says one thing about the night.

Talk:
* her side of the 2023 story, as testimony and not accusation, and what she thought the next day
* her admission that she has not forgiven him and has not stopped either
* "tell him I know the difference between him and what he did"
* how she looks at V now, as someone who carries him, and what she owes V for that
* the laundry as the only honest chore of her week, said without irony
* (`keep`) she says thank you, and means it as a bargain

Outcomes:
* `walk-out` with `tell` (+100): "Rogue told you what she never said to Johnny, in a laundromat at three in the morning, and you told her what he said back." `history`, permanent: she
  sometimes speaks to V and, a little, past V.
* `walk-out` with `keep` (+95), `lie` (+85, "you let it lie, and she did not ask again").
* `memory-share`: if Johnny's SH5 or SH6 run later, his talk knows V sat with her this night (a note, not a scene).
* Rewards: none.

Images:
* `never-said-laundromat.png`, sent at `spin`: an all-night laundromat, a row of round washer doors, a long coat over a plastic chair, a woman's hands folding a shirt, fluorescent hum,
  green sign through the window, game-look photo mode.
* `never-said-door.png`, sent at `walk-out`: a washer's round glass door reflecting a tired face and a green neon sign, a faint chrome glint at the edge of the glass.

Build: `meet`, `seat`, `together`, `check` on the hour, `johnny-voice`, `history`, `memory-share`, `image`. Hard: nothing in the laundromat moves for real (no clothes are handled).

Pins: the meeting point, the all-night laundromat in Little China.

Lines: see BOND_QUEST_LINES.md, Rogue R6

### Rogue: scripted lines, holocalls and talk gaps

The scripted lines, the holocall scripts and the talk gaps (and the music and sound notes) of R1 to R6 are in [BOND_QUEST_LINES.md](BOND_QUEST_LINES.md), under Rogue Amendiares, quest by quest.

### Rogue reaches out first

All gated by `sq031_rogue` and `sq031_smack_my_bitch_up` finished, no `q103`, `sq031` or `q115` quest active.

| id | Trigger | Channel | Opening line(s) | Cooldown | What the LLM knows when V answers |
|---|---|---|---|---|---|
| RR.01 | After `sq031_rogue` (once) | text | "You came out of that alive. That's more than I expected. Come by the Afterlife." | once | the Smasher hunt, her unresolved bond with Johnny |
| RR.02 | Bond level-up 4, 5, 6, 8, 10 | text | "Notice you're around more. Fine. Don't make a habit of it." | 1 per level | the level title, her dry acceptance |
| RR.03 | V's heat is 3 stars or more (heat read) | holocall | "Heard you set the city on fire. Do you need a place to hide?" | 24 game hours | the wanted level, her contacts, the Afterlife as a hide |
| RR.04 | V's eddies very low or very high | text | "Ledger says you're broke. Or rich. Either way, we should talk terms." | 48 game hours | V's balance band, she treats help as work with a price |
| RR.05 | 04:00 to 06:00, V awake | text | "Can't sleep. Neither can I. Come have a coffee. Keep it quiet." | 36 game hours | the hour, her fatigue, the Afterlife is closing |
| RR.06 | V in the Afterlife's district at night for 5 minutes | holocall | "I saw you at the door. Come up to the booth when you're done." | 12 game hours | she can see the front door, she wants V for a small job |
| RR.07 | After `sq031_cinema` (once) | text | "Don't read into the movie. I didn't." | once | the drive-in, her guarded warmth |
| RR.08 | After a Rogue bond quest | text | "That went fine. Don't tell the others it went well." | 1 per quest | the quest just finished |

### Rogue hangouts (Westbrook Charter Hill and City Center Downtown)

Gate: `sq031_rogue` and `sq031_smack_my_bitch_up` finished, no `q103`, `sq031` or `q115` quest active. Invitations are texts or holocalls in her clipped voice.

#### RH1. Spot the Plant (Charter Hill, a cafe terrace, verify), bond 3

* **Invitation** (text): "Charter Hill. A terrace. Sit and watch. I'll tell you why after."
* **Activity**: **observation puzzle, `cast` and `check`**. Five passers-by walk the terrace path over 6 game minutes. One carries a concealed item (a case, a wire, a gun holster under a coat). V names the one, with a tag
  (`one` to `five`). Rogue gives hints only if V asks: "Look at the hands. Look at the shoes."
* **Twist**: two decoys, a courier with a briefcase and a man who keeps checking his watch.
* **Gap RH1.g1** after the third passer-by.
  * **asks** `RH1.g1.ask`, Rogue (copy), question, rogue: "What gave it away so far? Don't guess, tell me what you saw."
  * **knows** the five, the plant's identity, the decoys, V's tags so far.
  * **secret** which one it is.
  * **wants** V to reason out loud.
  * **idle** `chair`, a coffee in hand.
  * **resumes on** V's tag or the 6-minute timer.
  * **branches** reasoning aloud earns a bonus even when wrong.
* **Bond**: +6 accept, +4 right, +2 wrong but reasoned.
* **Variations**: (1) rain and umbrellas hide hands. (2) evening, a wedding crowd. (3) two plants, find both.
* **Image**: none.
* **Build**: `cast` x5 with a stage note, `check`, a tag pick, `seat` (chair).

#### RH2. Table for Two (City Center Downtown, a busy restaurant, verify), bond 4

* **Invitation** (text): "Downtown. Seven. There's no table. Get us one. I won't help."
* **Activity**: **negotiation by talk, `npc-react`**. The maitre d' (`cast`, a hospitality archetype) says the restaurant is full. V has to get a table using words only (no eddies, no threats). Outcomes: obey (a table), leave (he goes to find one), cower (threat, fail), police (fail).
* **Twist**: Rogue stays silent and watches. Each time V fails she lifts one eyebrow, the fixed bark.
* **Gap RH2.g1** after the first refusal.
  * **asks** `RH2.g1.ask`, Rogue (copy), question, rogue: "Why should he say yes? Think like him. What does he want?"
  * **knows** the maitre d' has a stage note (he fears bad reviews and loves a name), the rules, V may use any story.
  * **secret** that she once got a table by lying about who she was.
  * **wants** V to try a different angle.
  * **idle** `generic_arms_crossed`.
  * **resumes on** V's next attempt or a 3-game-minute timer.
  * **branches** a clever story earns a smile. A rude one earns a no.
* **Bond**: +6 accept, +5 table, +3 table by charm.
* **Variations**: (1) a food critic's name. (2) a lost tourist. (3) the table is for a "birthday".
* **Image**: none.
* **Build**: `cast` with a stage note, `npc-react`, `eddies` excluded by rule, `seat`.

#### RH3. Pretty Things (Charter Hill, a gallery, verify), bond 5

* **Invitation** (holocall): "Charter Hill. A gallery opens tonight. I like to see what rich people buy. Come."
* **Activity**: **guess the price, `place` x4**. In front of four works, V guesses the price band (`cheap`, `mid`, `obscene`). A dealer (`cast`) gives the real figure after each. Rogue also asks which piece Johnny would hate most (a talk beat).
* **Twist**: the dealer pitches V a piece. V can buy (`eddies`), haggle (`npc-react`) or refuse.
* **Gap RH3.g1** after the third work.
  * **asks** `RH3.g1.ask`, Rogue (copy), question, rogue: "Which one would Johnny hate? And which would he secretly want?"
  * **knows** the four works, the dealer's pitch, Johnny is in V's head.
  * **secret** that she once bought him a painting he never hung.
  * **wants** a real answer.
  * **idle** `rogue`, hands behind her back.
  * **resumes on** V's reply.
  * **branches** V's pick is told to Johnny as a `memory-share` note.
* **Bond**: +6 accept, +3 per right band up to +6, +2 for the Johnny question.
* **Variations**: (1) an auction. (2) a sculpture garden. (3) a retrospective of a painter she dislikes.
* **Image**: 1, `pretty-things.png`, V's own shot: a bright gallery with a single oversized abstract canvas, a woman in a dark coat looking at it from behind.
* **Build**: `place` x4, `cast`, `eddies`, tag picks, `memory-share`, `image`.

#### RH4. Shake the Tail (City Center Downtown streets), bond 6

* **Invitation** (text): "Someone's following us. Walk with me and lose him. Don't look back."
* **Activity**: **counter-surveillance walk, `unseen`**. A `cast` follower (a nameless young man with a camera drone) trails them. V leads Rogue through three `place` doors or shortcuts to lose him in 10 game minutes. Rogue gives tips on the way.
* **Twist**: he turns out to be an intern from a gossip site. Rogue buys him a coffee and gives him a tip: stop following people.
* **Gap RH4.g1** at the start.
  * **asks** `RH4.g1.ask`, Rogue (copy), question, rogue: "Which way would you lose him? Alley, crowd or building? Tell me before you go."
  * **knows** the follower, three routes, the intern twist (not told), a 10-minute timer.
  * **secret** that she already knows who it is.
  * **wants** V's plan.
  * **idle** `generic_arms_crossed`.
  * **resumes on** V's first move.
  * **branches** V's plan sets which route Rogue helps with.
* **Bond**: +6 accept, +5 shake him, +3 after the coffee.
* **Variations**: (1) rain, reflective glass. (2) two followers. (3) night, a metro station.
* **Image**: none.
* **Build**: `cast` follower, `unseen`, `place` x3, `npc-react`.

#### RH5. Last Light (City Center Downtown, a high-rise bar, verify), bond 8

* **Invitation** (text): "Sunset. A bar I keep for myself. I'll buy. You tell me a story."
* **Activity**: **tasting game, `seat` at a bar and `check` of the hour**. At sunset the bartender (`cast`) pours three glasses. V picks the cheapest by tag (`one`, `two`, `three`), data decides. Rogue tells a story, V tells one, each short.
* **Twist**: the bartender knows Rogue from the old days and tells a harmless story about her.
* **Gap RH5.g1** after Rogue's story.
  * **asks** `RH5.g1.ask`, Rogue (copy), question, bar: "Your turn. Something true and small. Not a war story."
  * **knows** the three glasses, the bartender's stage note, the sunset, V's story is brief.
  * **secret** that she hasn't told a small story in years.
  * **wants** V's honest tale.
  * **idle** `bar`.
  * **resumes on** V's reply or a 6-game-minute timer.
  * **branches** a small honest story earns a nod. A war story earns a raised eyebrow.
* **Bond**: +6 accept, +4 right glass, +6 for a small true story.
* **Variations**: (1) rain on the glass. (2) a late-night bar. (3) a single-malt flight.
* **Image**: 1, `last-light.png`, V's own shot: two glasses on a bar at sunset, a city skyline behind, a woman's hand resting beside one.
* **Build**: `seat` bar, `check` (hour), `cast`, tag picks, `image`.

### Rogue's gifts

* **Loved**: a good whisky or aged spirit, a well-kept classic firearm, a burner phone or a useful encrypted shard, a clean tactical tool, quality coffee beans.
* **Liked**: a pack of cigarettes, a leather glove or coat, a useful intel shard, a tidy ledger book.
* **Disliked**: flowers or sentimental gifts meant to win her over, anything that looks like a bribe, party favours, a client's stolen goods.

| id | tier | speaker | line | emotion | animation |
|---|---|---|---|---|---|
| RG.loved | loved | Rogue (copy) | Now that's a gift worth taking. Thank you. | nod | rogue |
| RG.liked | liked | Rogue (copy) | Useful. Fine. Don't make a habit of it. | shrug | rogue |
| RG.disliked | disliked | Rogue (copy) | Flowers. Really. Take them away. | disgust | generic_arms_crossed |
| RG.give.common | common | Rogue (copy) | Here. A burner phone. It's not a present. It's a tool. | neutral | rogue |
| RG.give.uncommon | uncommon | Rogue (copy) | A pack of smokes. Don't tell anyone I gave you these. | shrug | rogue |
| RG.give.rare | rare | Rogue (copy) | A shard I owe you. Keep it safe. | nod | rogue |
| RG.give.epic | epic | Rogue (copy) | A good pistol. I used it. It never failed me. | emphatic | rogue |
| RG.give.legendary | legendary | Rogue (copy) | A number. It opens any door in the Afterlife. Use it once, and well. | sad | rogue |

---

## 10. Kerry Eurodyne

Canon anchors: a guitarist, singer and former SAMURAI member whose solo career outlived decades of music, living in North Oak, signed to MSM Records. His ambivalence about Johnny is the
engine of the character: he is proud of the band and tired of being asked about it, and he cares about whether people come for his name or for his music. He orders a double espresso,
Jamaican blend, no sugar, and remembers the early SAMURAI gigs as rough and poor, with the money going into guitars and strings. Nancy Hartley (now Bes Isis at N54), Denny and Henry are
old bandmates, Louise is his former wife and Ted and Kim his children in Tokyo (private, never narrated). He is bisexual, he swears and he checks that you are all right. His car is the
Rayfield Aerondight "Guinevere" (`her-car`, `verify` it is in the catalogue). The existing pack "Something New" covers a new song and an honest opinion, so no quest here is about a
song. Ladder: 3, 4, 5, 6, 8, 10.

Shared gate: no `sq011`, `sq017` or `sq028` quest active.

### K1. Caliente Mornings (`kerry-caliente`)

Gate: bond 3, `sq011_kerry` (the visit to his villa) finished. Any relationship. Needs Immersive invitations.

Premise: Kerry is up early, bored in a villa that echoes, and wants a cup of coffee in a place where nobody knows his name. He remembers a diner from the SAMURAI days where he drank
too much coffee. He drives V there. It might not exist any more.

Stages:
1. `text`: **text and `meet`** at his villa gate (North Oak `place`), 08:00. "Double espresso. Jamaican blend. No sugar. If you say sugar I'm leaving."
2. `ride`: **chauffeur in Guinevere**. He drives V (`her-car` + `chauffeur`) to the address he remembers (`verify` where Caliente stood, else a pack list of three coffee spots in Watson
   and Westbrook). V is in the passenger seat.
3. `corner`: **discover**. If the old place is gone, he stands on the corner for 5 game minutes (`together` at the `place`) and the moment is quiet. If it still exists, he goes in.
   Either way he picks the nearest counter.
4. `order`: **sit together**, `seat`, 10 game minutes. His order, V's order (a tag `plain`, `sugar`, `other`). He teases or approves.

Talk:
* early gigs: the rough rooms, the arguments, the money that went into strings and not food
* coffee as the measure of being a nobody
* a self-deprecating line about the label, MSM, who think he is in a studio
* a question back: where was V's first place that felt like theirs?

Outcomes:
* `order` (+45): "Kerry took you to the place he remembered from the SAMURAI days, and you drank coffee on the corner where it used to be." `history`: he calls any cheap coffee "caliente".
* `order` with `sugar` (+40, he never lets it go).
* `half` (+25), `stood-up` (-5).
* Rewards: none.

Images:
* `caliente-cups.png`, sent at `order`: two tiny espresso cups on a scratched formica counter, a ring of coffee on a napkin, morning light, game-look photo mode.
* `caliente-flyer.png`, a memory image sent the next game day with "found this in a box": a photocopied gig flyer with a coffee ring, "SAMURAI - cheap, loud," a smudged phone number.

Build: `text`, `meet` at a `place`, `her-car` + `chauffeur`, `together` at a `place`, `seat`, `image`, `history`.

Pins: the meeting point, Kerry's villa gate in North Oak.

Lines: see BOND_QUEST_LINES.md, Kerry K1

### K2. Incognito (`kerry-incognito`)

Gate: bond 4, `sq011_concert` (the Red Dirt concert) finished. Any relationship.

Premise: Kerry has not eaten at a street stall in twelve years because someone always lifts a phone. He wants to cross the Japantown night food street in the dark with a hat and a scarf,
and V to run interference.

Stages:
1. `plan`: **talk**. A disguise: `outfit` (one of his own appearances, `verify` there's a plain one), a scarf, glasses. He asks V to keep an eye out. Tags: `in`, `no`.
2. `crowd`: **social stealth**. A 600 m route through the Japantown night food street (`verify` it exists) (five `place` points, ending at a stall). Three recognition events at fixed points, each a `cast` extra: a teenage fan,
   a guard who stares and lifts a phone, and a paparazzi drone (a nameless operator). V can talk the extra away (the ordinary NPC rules: they leave, they cheer, they follow), block the
   line, or lead Kerry down a side lane. A lifted phone fails the route (`seen`). The route can be tried once more.
3. `stall`: **sit together** at the stall bench (`seat`, `together` 15 game minutes). A bowl (narrative only). He says the stall beats any restaurant he owns.
4. `unmasked`: **talk**. Leaving, a small kid recognizes him. V can step in (tag `step-in`) or let it happen (`let`). He signs a drink coaster for the kid.

Talk:
* the cost of being known: not the crowd, but the angle of the lens
* how it felt to be a nobody for a minute, and how much he hated that he liked it
* his flirtation as a dry aside, and no more
* the kid's face as the one he didn't mind

Outcomes:
* `unmasked` after an unseen meal (+45): "You walked Kerry through a Japantown night market unrecognized, and he signed a coaster for one kid when he was."
* `seen` (+35), `retreat` (+10, V ended the route).
* Reward: none. `history`: he wears a hat when V suggests it.

Images:
* `incognito-stall.png`, sent at `stall`: two figures in hats on a Japantown food stall bench from behind, steam, neon, a paper lantern, game-look photo mode.
* `incognito-coaster.png`, sent at `unmasked`: a drink coaster with a quick signature and a lopsided star, held by a small hand.

Build: `meet`, `outfit`, `cast` x3 with recognition behavior (new, small), `npc-react`, `place` x5, `seat`, `together`, `image`, `history`.

Lines: see BOND_QUEST_LINES.md, Kerry K2

### K3. Guinevere Wants to Run (`kerry-guinevere-race`)

Gate: bond 5, `sq017_kerry` (the coffee outing) and `sq017_01_riot_club` finished. Any relationship. Heat must be zero.

Premise: Kerry's Aerondight hasn't been pushed in a long time. He thinks of it as a living thing. He challenges V to a race, V's car against Guinevere, from the villa gate to a
finish line he names, with a stake: the winner chooses what plays on the radio for the drive home.

Stages:
1. `dare`: **talk**. He lays the rules: no ramming, no cops, heat zero or the race is void. Tags: `race`, `no`.
2. `start`: **meet at the gate** (`place`, the North Oak gate). A `check` on heat. His `remote` countdown.
3. `race`: **`race`**. Kerry drives Guinevere (`her-car`) to the finish `place` (the Atlantis Stadium lot in Heywood, `verify`), V drives any vehicle. The first to arrive wins. A slow
   watch tracks both. If a wanted level starts, the race is void (`void`). Checkpoint lines from him at one third, two thirds and the last stretch.
4. `finish`: **`radio` check and talk**. The winner picks the station. The `check` reads what is on.

Talk:
* a rock star's love of a machine, the same hunger as for a good riff
* "she's an old lady, treat her like one," and then "no, don't"
* a plain joke about his age, a plain admission that the drive scared him a little
* (`won-by-V`) a gracious fury, and a request for a rematch

Outcomes:
* `won-by-V` (+50): "You beat Kerry's Guinevere on the road from North Oak, and you picked the station."
* `won-by-Kerry` (+45), `photo-finish` (+55, within 3 s: "he said you'd drive it better than him one day").
* `void` (+10), `no` (+0).
* Reward: none (the stake is the radio).

Images:
* `guinevere-run.png`, sent at `finish`: the Aerondight's long hood at speed on a night road, headlight streaks, motion blur at the edges, game-look photo mode.
* `guinevere-line.png`, sent at `finish`: two cars nose to nose under stadium lights, one white and low, one dark and square, a figure leaning on the hood of the first.

Build: `her-car`, `race` (new), `heat`, `check` (heat, radio), `remote`, `place` x2, `image`. Hard: no stunt driving or camera work for the copy, the race is the copy's normal
`chauffeur` to a point.

Pins: the meeting point, the North Oak gate.

Lines: see BOND_QUEST_LINES.md, Kerry K3

### K4. Bootleg (`kerry-bootleg`)

Gate: bond 6, `sq017_02_lounge` finished, none of his quests active. Any relationship.

Premise: a collector who calls himself Kerry's biggest fan has taken Kerry's guitar tech of thirty years (nameless) to a private museum in a closed Westbrook theatre, and demands that
Kerry come and play for him. Kerry is furious and a little ashamed that it is his own fans. He doesn't call the police. He calls V.

Stages:
1. `text`: **call-in or text**. "They took my tech. Man wants a private show. Come now." (Kerry never names the tech.) `meet` at his villa gate within 1 game hour.
2. `ride`: **`ride`**. V drives him to the theatre (`place`, a closed theatre in Westbrook, `verify`).
3. `museum`: **hostage rescue with Kerry as the bait**. A `squad` of 6 collector's guards (relaxed, wearing fan-club jackets) and a `hostage` (the tech, in a display-case room on the second
   floor). Kerry walks in at the front door and the guards, who are fans, hesitate for 30 s (the `npc-react` obey-and-stare behavior), which is V's window. Kerry goes up the middle, V
   goes around the side (`unseen`). Reaching the hostage (within 2 m for 5 s) frees him. If V is seen the guards turn hostile (`loud`). In a fight Kerry stands behind a column and shouts
   instructions.
4. `out`: **escort**. The tech follows V out. Kerry signs one guard's jacket. `ride` back to the villa.
5. `after`: **talk** at the villa gate. The tech goes in. Kerry asks V to stay a while.

Talk:
* anger at obsession, which he understands better than he'd like
* gratitude disguised as insult
* the museum as everything he never wanted kept
* (`loud`) "next time I'll sign something and we all go home"

Outcomes:
* `after` after `clean` (+75): "A collector took Kerry's guitar tech to a private museum, and Kerry's face bought you thirty seconds to get him out." Reward: 1,500 eddies (`eddies` gift).
* `after` after `loud` (+55), `lost` (+20, the tech is dead, and Kerry doesn't talk for days: a 7-day note).
* `memory-share`: Nancy's game-placed copy (talk only) hears about it, since she is Kerry's old bandmate and now a reporter.

Images:
* `bootleg-museum.png`, sent at `museum`: a dim theatre foyer with glass cases of fake SAMURAI memorabilia, a velvet rope, one case with an empty hook, game-look photo mode.
* `bootleg-jacket.png`, sent at `out`: a guard's fan-club jacket with a marker signature across the chest, held up by the sleeve.

Build: `call-in`, `meet`, `ride`, `squad` (relaxed, fans), `hostage`, `unseen`, `npc-react`, `post` for Kerry (he stays at the door), `eddies`, `memory-share`, `image`.

Pins: the meeting point, Kerry's villa gate in North Oak.

Lines: see BOND_QUEST_LINES.md, Kerry K4

### K5. Tomorrow in Tokyo (`kerry-tomorrow-tokyo`)

Gate: bond 8, `sq028_kerry_romance` (the marina evening) finished, none of his quests active. Any relationship. The quiet one.

Premise: Kerry's children are in Tokyo, where it is already tomorrow (a day ahead of Night City, no hours are named). Tonight is a rare call. He asks V to be on the boat while he takes it, not to listen and not
to leave, because he is more nervous about the call than about any stage.

Stages:
1. `ask`: **`meet`** at the marina (`place`, his boat's pier, sq028's marina) at dusk. "Don't be weird about it."
2. `deck`: **sit**. `seat` on the deck, `together` 10 game minutes. He prepares, drinks his coffee and checks the time.
3. `call`: **keep your distance**. Kerry goes to the stern. A pair of radii: V must stay inside the outer ring (15 m) and outside the inner (5 m) for 10 game minutes. The pack's slow watch
   (1 Hz, only while this stage waits) tracks V. If V comes inside the inner ring, he ends the call early (`eavesdrop`). His half of the call is never rendered.
4. `after`: **sit** again. He comes back quiet. He asks V what V would say to someone far away. Tags: V answers (`answer`), V doesn't (`silent`).
5. `water`: **sit with feet over the pier** until the lights come on across the marina.

Talk:
* private, never the content of the call: only the before and the after, his hands, his tone
* "they asked about the guitars," the only line, once
* the shape of a family that is far away, without a villain
* a plain statement of what he wants from V, said once and not repeated
* (`eavesdrop`) a real anger and a real apology a day later

Outcomes:
* `after` after `call` (+90): "Kerry took a call from Tokyo at the stern of his boat while you kept your distance. Afterwards he asked you a question."
* `eavesdrop` (+40), `stood-up` (-5).
* Lasting: `history`: he mentions "the stern" when trusting V.
* Rewards: none.

Images:
* `tokyo-marina.png`, sent at `after`: a moored boat at night, one lit cabin window, the glow of a phone at the stern, two mugs on the deck rail, game-look photo mode.
* `tokyo-pier.png`, sent at `water`: two pairs of boots dangling over the end of a pier, the marina lights on the water, two mugs between them.

Build: `meet`, `seat` ground, `together`, a **privacy ring** (two radii at one place, slow watch: new, named `apart`), `history`, `image`. Hard: no sailing, no boat movement.

Pins: the meeting point, the marina pier.

Lines: see BOND_QUEST_LINES.md, Kerry K5

### K6. First String (`kerry-first-string`)

Gate: bond 10, `sq028_kerry_romance` finished, `kerry-tomorrow-tokyo` finished (`after`), none of his quests active. Any relationship.

Premise: Kerry's first guitar, a cheap one with his initials cut into the headstock, was lost long ago in the band's poor years (an invention of this quest, kept by the owner on 29 Oct). He
has never looked for it. He asks V to look, because he can't stand to learn that it's gone, and doesn't want to find it alone if it isn't.

Stages:
1. `ask`: **talk**. The request, in his terms. Tags: `in`, `no`.
2. `leads`: **investigation, `archetype-talk`**. Three shops, three leads (a pawn shop in Little China, a music repair shop in Westbrook, a street instrument stall in Kabuki). Each is a
   `cast` shopkeeper with a stage note. They don't know him. V asks in words that name the guitar's marks. The three answers give a name, a street and a rumour. A hint ladder (one
   hint per game hour, as in Judy's hill) tells V where to go next if V stalls.
3. `underpass`: **find and listen**. A Metro underpass in Watson (`place`) with a young busker (`cast`) playing a battered acoustic (a guitar `workspot` on the busker, `verify`). Nobody
   hears music in the pack. V sees the headstock (an `image`). V can ask the busker to sell it (`buy`, 500 to 1,500 eddies via the small "pay an NPC" flow), tell Kerry (`tell`), or leave it
   be (`quiet`).
4. `meet`: **Kerry arrives**. He waits in Guinevere at the underpass entrance (`post`). He hears the guitar from across the street. He doesn't go near.
5. `walk-away`: **walk** with Kerry. He says leave it. Or, after `buy`, he takes it and, awkward, puts it back in the kid's hands.

Talk:
* the guitar as a first love that doesn't need to be returned
* "all I needed to know is that it still gets played"
* his fear of the public version of himself eating the private one
* the kid, whom he doesn't talk to, and the eddies he leaves in the case
* V as the person who finds things and lets them be

Outcomes:
* `walk-away` with `quiet` (+100): "You found Kerry's first guitar in a Watson underpass, in a kid's hands, and he asked you to leave it there." `history`, permanent.
* `walk-away` with `buy` (+90), with `tell` (+95).
* `not-found` (+45, the leads dried up and he said it was fine).
* Reward: none. A lasting line: when asked what V gave him, he says "a reason to stop looking".

Images (the top quest, up to 6):
* `first-string-pawn.png`, sent at `leads`: a pawn-shop wall of instruments, a cracked acoustic with duct tape on the neck among them, a price tag on a string, game-look photo mode.
* `first-string-headstock.png`, sent at `underpass`: a close-up of a scratched headstock with a carved "K.E." and a duct-tape repair, shallow focus, tunnel light.
* `first-string-underpass.png`, sent at `meet`: a Watson underpass at night, a young busker on a milk crate, a case open with a few coins, a white car in the distance, a coat-clad figure leaning on it.
* `first-string-case.png`, sent at `walk-away`: the open guitar case with a folded roll of eddies among the coins.

Build: `meet`, `post`, `archetype-talk`, `cast` x4 with stage notes (new use), hint ladder on `place` (new, small), `workspot` guitar on the busker (`verify`), `eddies` pay-an-NPC (small),
`image`, `history`. Hard: no music is heard.

Lines: see BOND_QUEST_LINES.md, Kerry K6

### Kerry: scripted lines, holocalls and talk gaps

The scripted lines, the holocall scripts and the talk gaps (and the music and sound notes) of K1 to K6 are in [BOND_QUEST_LINES.md](BOND_QUEST_LINES.md), under Kerry Eurodyne, quest by quest.

### Kerry reaches out first

All gated by `sq011_kerry` finished, no `sq011`, `sq017` or `sq028` quest active.

| id | Trigger | Channel | Opening line(s) | Cooldown | What the LLM knows when V answers |
|---|---|---|---|---|---|
| KR.01 | After `sq011_concert` (once) | text | "Still ringing in my ears. Best night in years. Come by the villa. Bring coffee." | once | the Red Dirt concert, his mixed feelings about Johnny |
| KR.02 | Bond level-up 3 to 10 | text | "You keep showing up. That's rare. Don't ruin it." | 1 per level | the level title, he makes a joke about being liked |
| KR.03 | Thursday night 20:00 to 23:00 | holocall | "Thursday. Riot club. I need a drinking partner who doesn't want an autograph." | 7 game days | the Riot club (sq017_01), Us Cracks, his love of low-key venues |
| KR.04 | V near North Oak for 5 game minutes | text | "I can see you from the balcony. Come in. Stop loitering." | 24 game hours | North Oak, his villa, coffee |
| KR.05 | V's radio plays a Kerry or SAMURAI song (radio event) | text | "That's my song. Ha. Were you listening, or did the radio decide?" | 24 game hours | the song title from the radio, no lyrics, his ambivalence |
| KR.06 | After `sq028_kerry_romance` (once) | text | "Last night was good. Don't overthink it. Overthink it a little." | once | the marina, the relationship with V, his bisexuality as a plain fact |
| KR.07 | V survived a fight with health under 20 percent (the battle summary of the last hour) | holocall | "You alright? You look like hell. Come have a coffee." | 24 game hours | V's recent fight, he checks V is all right, his bluntness |
| KR.08 | After a Kerry bond quest | text | "That was strange. Good strange. Let's do it again someday." | 1 per quest | the quest just finished |


### Kerry hangouts (North Oak, the Pacifica coast, Westbrook outside Japantown)

Gate: `sq011_kerry` finished, no `sq011`, `sq017` or `sq028` quest active.

#### KH1. Pick the Pick (North Oak, a vintage instrument shop, verify), bond 3

* **Invitation** (text): "I need strings. And a witness. North Oak, the little shop with the bad sign."
* **Activity**: **blind-match game**. Kerry describes a tone ("warm, a bit sad", "bright and rude", "thick like honey"). Three guitars hang on the wall. V picks which one fits (tags `a`, `b`, `c`), and data decides. No sound is played.
* **Twist**: the shopkeeper (`cast`) recognizes him and pretends not to. Kerry buys a cheap pick and gives it to V as a keepsake.
* **Gap KH1.g1** after the first description.
  * **asks** `KH1.g1.ask`, Kerry (copy), question, kerry: "What does 'warm and sad' look like to you? Pick one and tell me why."
  * **knows** the three guitars, the descriptions, no sound, the shopkeeper's act.
  * **secret** that he once chose a guitar by color, not tone, and it was perfect.
  * **wants** V's reasoning.
  * **idle** `lean`.
  * **resumes on** V's tag.
  * **branches** right pick -> "You have ears." Wrong -> "Close. I was trying to trick you."
* **Bond**: +6 accept, +3 right, +6 for all three.
* **Variations**: (1) strings (thin, thick, rusty). (2) amplifier knobs. (3) old picks.
* **Image**: none.
* **Build**: `place`, `cast`, tag picks, `items` (a pick, unverified).

#### KH2. Driftwood Fire (Pacifica coast, a beach, verify), bond 4

* **Invitation** (text): "Beach. Sunset. We're making a fire out of garbage. You'll love it."
* **Activity**: **gather and sit**. V visits three driftwood `place` points, then sits `seat` ground at a fire spot (a campfire workspot, "verify") for 10 game minutes with `check` of the hour (dusk).
* **Twist**: the waves leave a bottle with a message. The message is a fixed line from a pack list of ten harmless notes.
* **Gap KH2.g1** at the fire.
  * **asks** `KH2.g1.ask`, Kerry (copy), question, kerry: "Where would you go if you could go anywhere with no one knowing you?"
  * **knows** the beach, the fire, the bottle's message, the hour.
  * **secret** that he sometimes drives to the coast and sits in the car.
  * **wants** V's dream.
  * **idle** `couch` on a log, or `seat` ground.
  * **resumes on** V's reply or the 10-minute timer.
  * **branches** a place name is repeated by Kerry in a later line.
* **Bond**: +6 accept, +3 gather, +5 for a full fire sit.
* **Variations**: (1) a cold windy dawn. (2) rain, no fire, a blanket. (3) a bonfire with a few cast strangers.
* **Image**: 1, `driftwood-fire.png`, V's own shot: a small fire on a dark beach, two pairs of boots, the sea black beyond.
* **Build**: `place` x3, `seat` ground, `workspot` fire (verify), `check`, `cast` (optional), `image`.

#### KH3. Midnight Fridge Run (Kerry's villa, North Oak), bond 5

* **Invitation** (holocall, trigger 00:00 to 02:00): "I'm starving. Staff is asleep. Come sneak with me."
* **Activity**: **stealth in a house, `unseen`**. A harmless security drone (`cast`, a patrolling prop) and a sleeping housekeeper (`cast`) cover the route. V and Kerry reach four `place` points (stairs, hall, kitchen door, fridge) without waking either.
* **Twist**: the housekeeper wakes anyway, catches them, and makes sandwiches. Kerry is both angry and delighted.
* **Gap KH3.g1** at the fridge.
  * **asks** `KH3.g1.ask`, Kerry (copy), question, kerry: "What do you eat at 2 a.m. when no one's looking?"
  * **knows** the four points, the drone and housekeeper, the sandwich twist.
  * **secret** that he cooks only when he can't sleep.
  * **wants** V's late-night truth.
  * **idle** `lean` on the fridge.
  * **resumes on** V's reply or a 3-game-minute timer.
  * **branches** V's answer decides the sandwich.
* **Bond**: +6 accept, +4 reach the kitchen, +6 for the sandwich.
* **Variations**: (1) a different route (the back garden). (2) a power cut. (3) a guest sleeping on the couch.
* **Image**: none.
* **Build**: `unseen`, `place` x4, `cast` x2, `npc-react`.

#### KH4. Echo Pier (Pacifica, an old pier, verify), bond 6

* **Invitation** (text): "Old pier. Great echo. Bring your voice. Not for singing."
* **Activity**: **find the best echo, `place` x3**. At each, V shouts a word or name (a tag with their choice), and Kerry rates the acoustic with a seeded roll (`flat`, `ok`, `gorgeous`). V picks which spot to remember.
* **Twist**: the pier groans and a flock of birds takes off, which Kerry insists was his idea.
* **Gap KH4.g1** after the second spot.
  * **asks** `KH4.g1.ask`, Kerry (copy), question, kerry: "What word would you shout, if you didn't care who heard?"
  * **knows** the spots, the roll results, birds.
  * **secret** that a word he shouts here is a name.
  * **wants** V's word.
  * **idle** `lean` on a rail.
  * **resumes on** V's reply.
  * **branches** V's word is spoken back in a later gag.
* **Bond**: +6 accept, +4 all three spots, +4 for the gorgeous one.
* **Variations**: (1) fog. (2) a tunnel under the pier. (3) a sea cave.
* **Image**: none.
* **Build**: `place` x3, tag picks, seeded roll, `cast` (birds are ambient, "verify").

#### KH5. Garden Party Crashers (North Oak, a neighbour's garden, verify), bond 8

* **Invitation** (text): "Neighbour's party. Not invited. We're going as plus-ones. You're my cousin."
* **Activity**: **social stealth**. Six guests (`cast`) mingle at the party. V and Kerry must avoid the host for 8 game minutes while V talks to two guests (`archetype-talk`).
* **Twist**: the host asks Kerry to play. He refuses. V is pulled into a toast instead, with V's own words.
* **Gap KH5.g1** after the first guest.
  * **asks** `KH5.g1.ask`, Kerry (copy), question, kerry: "What are we? Cousins? Business partners? Tell the next one the story."
  * **knows** the party, the host's habit of recognizing celebrities, V's cover story.
  * **secret** that he has been to this house and been bored.
  * **wants** V to commit to a story.
  * **idle** `kerry`, a drink in hand.
  * **resumes on** V's reply.
  * **branches** the cover story is quoted by guests.
* **Bond**: +6 accept, +4 avoid the host, +6 for a good toast.
* **Variations**: (1) a costume party. (2) a charity gala. (3) a wedding.
* **Image**: none.
* **Build**: `cast` x7, `archetype-talk`, `npc-react`, `unseen`-lite.


### Kerry's gifts

* **Loved**: guitars (any), guitar strings or picks, Jamaican blend coffee beans, vintage music media (records, tapes), SAMURAI memorabilia (he complains, but loves it).
* **Liked**: a good espresso, a leather jacket, music shards, a decent whisky, a handwritten note.
* **Disliked**: a Johnny-branded gadget, sugary coffee, a knock-off guitar, a corporate gift basket, anything MSM-branded.

| id | tier | speaker | line | emotion | animation |
|---|---|---|---|---|---|
| KG.loved | loved | Kerry (copy) | Oh, you beautiful bastard. Where did you find that? | happy | kerry |
| KG.liked | liked | Kerry (copy) | Nice. Thanks. It suits me. | nod | kerry |
| KG.disliked | disliked | Kerry (copy) | Johnny's face? On a mug? Please take it away. | disgust | kerry |
| KG.give.common | common | Kerry (copy) | Here. A guitar pick. I have a thousand. | neutral | kerry |
| KG.give.uncommon | uncommon | Kerry (copy) | A bag of coffee beans. Jamaican. Do not use sugar. | nod | kerry |
| KG.give.rare | rare | Kerry (copy) | A cassette from a gig. I made it myself. | happy | kerry |
| KG.give.epic | epic | Kerry (copy) | One of my old guitars. Don't tell anyone. | sad | kerry |
| KG.give.legendary | legendary | Kerry (copy) | Guinevere's keys. She likes you. That's all I can say. | sad | kerry |

---

## 11. River Ward

Canon anchors: an NCPD detective who wanted cases solved instead of forgotten (the mod frames him as ex-NCPD, his badge no longer decides what he
may do, verify against the save), brother of Joss Kutcher and uncle to Randy, Monique and Dorian. Their parents were killed by violent intruders
when River and Joss were children and nobody was ever brought to justice, which shaped his work. His old partner Jamie Sheen showed him what
institutional corruption costs, Harold Han is a police partner he still trusts, Yawen Packard is a former partner in his private life and a
professional contact. He is persistent and physically capable, and persistence can turn into tunnel vision that kept him away from his sister's
family. In V's story: the missing boy case (`sq021_sick_dreams`, the boy is Joss's son Randy per the profile text, verify), the Semimaru job on a
Watson highway (`mq057_motorbreath`), and the dinner with Joss and the water tower (`sq029_sobchak_romance`). He cooks jambalaya himself (tomatoes,
rice, onions, paprika, thyme, celery, garlic, and the stirring so it does not burn), calls a high view of the city calming, and has a dry, lightly
self-mocking humour. Joss's home is the Red Peaks trailer park per the profile and "a family farm in the Badlands" in the lead's frame (verify
which, no quest below is set there, the game-placed Joss, Randy, Monique and Dorian only talk). River has no car in the companion car catalogue:
he always rides in V's, so no quest uses `her-car` or `chauffeur` for him. His signature is detective work: questioning ordinary people
(`archetype-talk`, `npc-react`), following clues from place to place, and the stakeout (timed presence). The quests share one running case on
purpose (a ring that phones the families of missing children and sells false hope, a new crime, harmless to canon), seen from five angles, plus
a first light one and a last personal one. Ladder: 3, 4, 5, 6, 8, 10.

### RW1. The Case of the Real Celery (`river-real-celery`)

Gate: bond 3, `sq021_sick_dreams` (Sick Dreams) finished, none of his quests active. Any relationship. Eddies on.

Premise: Randy loves River's jambalaya, and jambalaya needs celery and tomatoes that are real. In a city fed on printed protein, a real vegetable
is a rumour. River has treated it like a case for two weeks and has a list of leads and no transport. He calls it "a case" and asks V not to laugh.

Stages:
1. `ask`: **text + meet**. "Need a second pair of eyes. It's a case. Don't laugh." `meet` at a diner `place` in Heywood (the exact corner captured in
   game), within 3 game hours. Stood up: `no-case`.
2. `leads`: **canvass by talk**, `party` on foot and `ride` between districts. Three leads, each an `archetype-talk` with an ordinary NPC of a
   kind in a district: a diner cook in Heywood, a delivery driver in Santo Domingo, a kid selling jars at the Badlands edge near the Biotechnica
   Flats road (verify the exact spot). River's rule is "never ask what they know, ask what they saw". V picks the questions (tags `warm`, `blunt`,
   `pay` for 50 to 200 eddies of information), and River writes the answers in a notebook. A wrong lead is a dead end that costs 10 game minutes.
3. `grower`: **small trouble**. A lean-to greenhouse stall by the roadside (`place`). A nameless grower (`cast`) and two scavs (`squad` of 2,
   relaxed, eyeing the crop). V talks them off (`npc-react` leave or cower), or it turns into a short fight. The grower sells one basket for
   400 eddies: V haggles (his reaction is the ordinary NPC decision), pays, or lets River pay (he does, grumbling).
4. `table`: closing beat. River puts the basket on V's car hood, declares the case closed, and says what he will cook on Sunday. An `image`.

Talk:
* the detective method turned on groceries, deadpan: suspects, alibis for a tomato
* small family details at level 3: Randy and his bowl, Monique and Dorian fighting over the last spoon, no heavy ground yet
* during the canvass: his patience with ordinary people, which is the part of the job he misses
* at the greenhouse: "somebody grows real food on purpose in this town. I want to shake his hand."
* a dry aside about how a case is only closed when someone eats

Outcomes:
* `found` (+50): "You and V tracked down a roadside grower with real celery and tomatoes for Randy's jambalaya." `history`: he calls V "my partner on the vegetable case".
* `found` with the scavs sent off quietly (+55): the same, and he says V has a gift for talking people out of doing stupid things.
* `store-bought` (V gave up before the grower, +25): "You could not find real celery and made do." He is quietly gracious.
* `no-case` (-5).
* Rewards: none in eddies. Later talk: he mentions Sunday's dinner and what Randy said about it.

Images:
* `real-celery-basket.png`, sent at `table` with "Evidence.": a wicker basket of dusty red tomatoes, a bunch of real celery, a head of garlic and an
  onion on the hood of a car at golden hour, a small black notebook open beside it, Badlands scrub behind, game-look photo mode, no faces.

Build: `meet` at a `place`, `party` + `ride`, `archetype-talk` x3 (kind and district), `cast` grower, `squad` of 2, `npc-react`, the pay-an-NPC
`eddies` flow (new, small), `image`, `history`. No new primitive.

Pins: the meeting point, the diner in Heywood.

Lines: see BOND_QUEST_LINES.md, River RW1

### RW2. Cold Coffee (`river-cold-coffee`)

Gate: bond 4, `mq057_motorbreath` (Motorbreath) finished, none of his quests active. Any relationship. Heat must be 0 at the start.

Premise: a ring phones families of missing children and says it has found their child, for a fee. River learned that the money is collected every
Thursday by a courier who passes through the lobby of a Northside tower. He cannot use police resources and has no car. He needs an unmarked one
and a second person to be bored with. A stakeout is mostly patience, and he wants to see whether V has any.

Stages:
1. `ask`: **text + meet**. He sends the address and an hour. `meet` at a Northside `place` (a coffee cart on the street), within 2 game hours.
2. `park`: **position**. V parks the car (V's own, or any car) within 40 m of the tower entrance with line of sight (a `place` check on the
   vehicle's position). River's `seat` is the passenger seat. He sets the rules: engine off, lights off, nobody speaks of anything that matters.
3. `watch`: **stakeout, timed presence**. `together` seated in the car, 90 game minutes, with a slow `check` of the hour. The point of a stakeout is not to
   react, so the rule is that nothing is resolved: two lures arrive as `cast` events (a kid who taps the glass to sell chewing gum, a ganger who
   walks twice round the car) and V is judged on doing nothing. Getting out of the car, honking or starting the engine ends the cover (`blown`) until the courier has left the lobby.
   At minute 65 the courier (a nameless woman in a grey jacket with a satchel) enters the lobby, and 5 minutes later leaves.
4. `follow`: **a short follow**. River follows on foot, 30 m behind, for 60 s (`party` on foot, no fight), V follows in the car and rejoins him.
   Branches:
   * quiet: River sees her hand the satchel to a van at an alley mouth and reads the plate out loud -> `noted`
   * V steps out and confronts her (tag `grab`): she runs, shouts or fights (`npc-react`), the van leaves -> `grabbed`
   * V leaves the car before the courier appears (tag `bored`) -> `blown`

Talk:
* the long middle: what River thinks about in a car, which is mostly his sister and mostly guilt
* the craft: how to look at a window without looking at it, why you never watch the door you expect
* the ring, from his side: what it costs a mother to hear "we found him" from the wrong mouth
* V's tags change the tone: `grab` gets "I was going to wait, and you're right that I would have waited too long"
* coffee jokes about the cart's coffee, which has been cold since the first hour
* when a lure arrives: "Don't. That's what it's for."

Outcomes:
* `noted` (+60): "You and V sat out ninety minutes in a car in Northside and got the plate of the ring's van." `history`: "the plate", which RW3 reads.
* `grabbed` (+45): the courier ran and the van left. He thanks V for the nerve and says the plate is lost.
* `blown` (+15): "V left the stakeout before the courier arrived." He is not angry. He goes alone next Thursday.
* `no-show` (-5).
* Rewards: none.

Images:
* `cold-coffee-windshield.png`, sent after `watch`: the view through a rainy windshield at night of a lit tower lobby with a tiny figure in a grey
  jacket crossing it, two paper coffee cups on the dashboard, a notebook on a knee, game-look photo mode.

Build: `meet` at a `place`, `place` check on the car's position (new, small), `seat`, `together` in a car for N game minutes (new combination),
two `cast` lures with a no-reaction rule (unlike J2's incidents, nothing is resolved), `party` follow on foot, `history`.

Pins: the meeting point, the coffee cart in Northside.

Lines: see BOND_QUEST_LINES.md, River RW2

### RW3. Open Window (`river-open-window`)

Gate: bond 5, RW2 finished (`after`) and `sq021_sick_dreams` finished, none of his quests active. Any relationship. If RW2 ended `blown` or was
never played, River arrives at the address by a different tip and the quest still runs.

Premise: the plate led to a flat in a Westbrook tower where the ring keeps its list of families. River cannot go in without a warrant he no longer
has. He can keep the building's super talking on the street, he is better at it than anybody. V can go in through the fire escape. He wants the
list and nothing else, and he says that more than once.

Stages:
1. `plan`: **talk**. In V's car across the street (`meet` at a Westbrook `place`). Tags: V goes in (`in`), V wants to ask for the list at the door
   (`door`, he says nothing will come of it, but he admits a nice approach is how he got into most flats), V declines (`no`).
2. `distract`: River's copy walks to the lobby, takes a `post` and starts the conversation with the super (a `cast` man, a nameless building
   super). His patience is a visible timer of 8 game minutes (the super goes up to check on the noise if it runs out). River speaks to V through
   `remote` only when the super is looking away.
3. `search`: **stealth indoors**. V climbs the fire escape to the flat's window (`place`, 40 m of climb). Inside, a `squad` of 1 sleeping lookout
   (relaxed) and one guard dozing in the kitchen. Three inner `place`s with a 4 s dwell each: a list of names on a wall, a drawer of cheap burner
   phones, a calendar with every Thursday ringed. `unseen` is required for the lookout, not for the guard who is deaf with headphones. V must be
   out the window before the 8 minutes are up.
4. `out`: **exit and talk**. Both leave in the car. River reads the list aloud in the dark, quiet, and does not look at V.

Talk:
* before: "I used to wait for a warrant. I wait for Thursdays now."
* in V's ear: the lightest voice he owns, cheerful, a man talking about the weather to a stranger
* after the list: he does not speak, then reads a name that is not on the list and is the one he cannot get out of his head
* about Harold Han: whether to bring it to him, and what it would cost Han
* (`door`) he laughs for the first time in the arc

Outcomes:
* `all-three` (+65): "You and V found the ring's list while River held the super on the street." Lasting: he brings the list to Han (talk) and tells V what Han said.
* `two-clues` (+50): the list was not complete, the calendar was missing.
* `spotted` (+35): the lookout woke up, V ran, the super went upstairs.
* `no` (+5), `door` (+0, same as `in` but loud).
* Rewards: none.

Images:
* `open-window-list.png`, sent after: a close view of a wall covered in handwritten names with a child's school photo pinned beside a ring of
  red thread, a desk lamp's yellow pool, a hand reaching in at the edge, game-look photo mode.
* `open-window-fire-escape.png`: a Westbrook tower's rusted fire escape at night from the street, a dark figure on the third landing, a man at
  the foot talking to another under a lamp, game-look photo mode.

Build: `meet` at a `place`, `post` + `remote` for River, a timer tied to a `cast` super (the super's reaction when it runs out is a
`npc-react` entry), `unseen` (new), `squad` of 2 with different alert rules, inner `place` x3 with dwell, `image` x2, `history`.

Pins: the meeting point, the Westbrook spot across the street from the target.

Lines: see BOND_QUEST_LINES.md, River RW3

### RW4. Polite Distance (`river-polite-distance`)

Gate: bond 6, RW3 finished (`after`), `sq021_sick_dreams` and `mq057_motorbreath` finished, none of his quests active. Any relationship.
Heat must be 0 at the start.

Premise: since the flat, an unmarked car has followed River for two days. He wants to know who is in it and does not want a shooting. He also does not
want the car to know he knows. His plan: V drives, he rides, and they lose the car without breaking a single traffic law, then wait where it will
turn up.

Stages:
1. `ask`: **call-in**. "I'm being followed. Come be a nice, boring driver." `meet` at a Watson `place`, 1 game hour.
2. `tail`: **drive with a pursuer**. A `runner` in reverse (a `tail`): a nameless driver's car (a dark sedan) follows V's car at 50 to 80 m. V drives
   a route of four checkpoint `place`s in Watson, Westbrook and Heywood (the Japantown loop, the Charter Hill street, a tunnel, the Heywood
   underpass) while River reads the mirror out loud. `heat` above 1 ends it (`hot`). V must lose the tail by distance (more than 200 m for 20 s).
3. `wait`: **ambush by talk**. V pulls into a car park (`place`) and parks. River gets out and waits by a stairwell door. The tail arrives, its
   driver (`cast`) gets out, and River steps out and says one sentence. The driver's reaction (`npc-react` talk, run, or draw) is the climax. V
   covers from the car (`post` for V is not needed, V simply stays within 20 m).
4. `name`: **talk**. What the driver told River, and who sent him. Not a name from canon: a name River knows and does not like.

Talk:
* the mirror: "left side, two cars back, he's too clean to be a cop"
* his rule for a tail: never run, never turn corners quickly, always make them think you are lost
* when V drives well, he stops reading the mirror and looks at V
* at the car park: the thing he learned from Jamie Sheen about talking to a man who thinks he has the upper hand
* afterwards: a small, honest joke about how long it has been since anyone worried about him

Outcomes:
* `named` (the driver talked, +70): "You and River lost a tail in Watson and cornered the man behind it with a single sentence."
* `lost-only` (the tail was lost but never found, +50): River settles for a week of looking over his shoulder.
* `hot` (heat above 1, +25): "The police noticed before the tail did." River laughs at the irony.
* `fight` (the driver drew, +45).
* `no-ride` (-5).
* Rewards: none.

Images:
* `polite-distance-mirror.png`, sent after: the rear-view mirror of a car at night, a pair of headlights three cars back, a hand resting on the
  wheel in the foreground, River's shoulder blurred beside it, game-look photo mode.

Build: `call-in`, `meet`, `ride` with ordered checkpoints and a heat rule, `tail` (new: a spawned car that follows V at a gap and is lost by
distance, the reverse of `runner`), `place` for the car park, `cast` driver with `npc-react`, `history`.

Pins: the meeting point, the Watson meeting place.

Lines: see BOND_QUEST_LINES.md, River RW4

### RW5. Until the Sun Comes Up (`river-until-dawn`)

Gate: bond 8, `sq029_sobchak_romance` finished (the dinner with Joss), RW4 finished (`after`), none of his quests active. Any relationship. Two
variants (partner or not) for the closing talk only.

Premise: the ring's youngest phone man (a nameless nineteen-year-old, new) wants out and will testify, and River promised him a safe place until Han's
car picks him up at dawn. The place is a disused farm outside the city, a farmhouse and a barn. River promised someone "I'll be there" once before and
was late, and that is why this one cannot go wrong.

Stages:
1. `call`: **call-in**. "I need you for one night. A witness. I'm bad at promising and I just did."
2. `drive`: **ride**. V drives River to the farm `place` in the Badlands (the exact farmhouse captured in game), 25 game minutes.
3. `prep`: **set the house**. The witness (`cast`, then `escortee` after V speaks to him) is told to wait in the cellar. River takes a `post` at
   the kitchen window. V picks a position (door, loft, yard) among three marked `place`s and River tells V the sightlines.
4. `hold`: **defend until dawn**. From 04:00 to 06:00 game time, three attacks by the ring's hired guns (`squad` x3, the third with a heavy):
   a car of three on the road, four on foot through the field, then two heavies behind a stolen truck. The quest does not wait for the squads to
   die, it waits for the clock. The witness must still be alive at 06:00 (`hostage` rule). A `hold-until` variant of the `squad`.
5. `dawn`: **sit on the porch**. `seat`, `together` seated 10 game minutes. Han's car is a text from River: "He's here." The closing talk.

Talk:
* before: tight, short, no jokes, the promise he made once and failed to keep
* during: practical, a running count, "one on the left, he's brave and stupid, I like him less than the others"
* at 05:30, in the dark: why he took the case in the first place, the ghost behind every case, and he does not say whose
* at dawn: coffee made on a camp stove, Joss, Randy, and a sentence about being present he has clearly been carrying
* partner variant: the water tower remembered, one line, no pet names

Outcomes:
* `dawn` (the witness alive, +85): "You and River held a Badlands farmhouse until dawn for a witness, and his promise was kept." `history`: "the farmhouse".
* `dawn` and no one in the squads reached the cellar (+90): the cleanest version.
* `lost` (the witness died, +20): a 5-day note: River stops texting first.
* `left` (V left the farm, +0): he never says it, he just says it is fine.
* Rewards: Han's thanks through River (no eddies, a `history` line). The witness is a `memory-share` target for Han (talk only).

Images:
* `until-dawn-farmhouse.png`, sent at `dawn`: a Badlands farmhouse porch at first light, shot-out window glass on the boards, two cups of coffee
  on the rail, a camp stove and a battered rifle leaning on the doorframe, game-look photo mode, no faces.
* `until-dawn-porch.png`: two shapes on a porch step in blue half-light, one resting a forearm on a knee, mist over the field.

Build: `call-in`, `ride`, `place` x3 for positions, `post` at a window, `cast` witness who becomes an `escortee` (a temporary follower, like the
`hostage` after a rescue), `squad` x3 with a car and a heavy (needs the "never a heavy" rule relaxed for this pack), `hold-until` (new variant:
success at a game hour rather than when the squads are down), `seat`, `together`, `text`, `image` x2.

Pins: the meeting point, the farmhouse in the Badlands, the pin River sends.

Lines: see BOND_QUEST_LINES.md, River RW5

### RW6. Off the Clock (`river-off-the-clock`)

Gate: bond 10, `sq029_sobchak_romance` finished, RW5 finished (`after`), none of his quests active. Two variants (partner or not).

Premise: River has not taken a day without a case since the badge. Today he promised himself one and he knows he will fail, so he asks V to be the
person who takes his phone. He will cook a pot of jambalaya for V at the water tower near Joss's place, the one spot where his head goes quiet. The whole thing is a test of whether he can sit still.

Stages:
1. `ask`: **text**. "I want one day. No phone. You hold it. If I reach for it, say something unkind." `meet` at V's flat or a `place` of V's choice.
2. `phone`: **handover**. A narrative beat: River gives V his phone (hard: no item transfer, the pack just turns off every `call-in` and `text`
   from River until the stage ends). He sets the water tower as the destination.
3. `drive`: **ride with three temptations**. V drives into the Badlands. Three `cast` incidents on the way, each timed:
   * a motorist with a smoking car at the roadside (a `cast` extra with a car, `npc-react`)
   * a man in the street whom River recognizes from a wanted list (a `cast` extra who bolts when he sees them)
   * an NCPD cruiser pulled over at a roadside stop, and an officer from his old precinct waves him over (a `cast` extra with a car)
   At each, V picks `hold` (River stays in the seat, grumbles) or `let` (River goes, does what he can, comes back). Whatever V chooses, he
   comments.
4. `ridge`: **camp meal and sit**. At the water tower `place` (the one from `sq029_sobchak_romance`, verify its spot), River sets
   up a camp stove and a pot (`workspot` cooking, verify, else he warms a pot he brought with `gestures`). `seat` on the tower's concrete footing,
   `together` seated 25 game minutes. The meal and the talk.
5. `card`: closing beat. He writes the recipe on a card and puts it in V's jacket pocket. An `image` of the card the next morning.

Talk:
* the recipe, as he says it aloud, step by step: tomatoes, rice, onions, paprika, thyme, celery, garlic, and the stirring so it doesn't burn
* the day itself: what it is like to ask his own brain to be quiet, how loud the Badlands are
* Randy, Monique and Dorian by their first names and in one sentence each, nothing heavy, the ordinary things they say
* the one case he cannot let go of, said without detail: the parents' case, and what it did to the shape of his days
* partner variant: why this water tower, said with one honest line
* friend variant: "family" said as a plain fact, an open chair at the next Sunday table

Outcomes:
* `whole-day` (V held the phone and never `let`, +100): "River spent a whole day off the clock with V and cooked for them at the water tower." `history`: "the day off".
* `slipped` (V `let` once or twice, +95): the same, and he is proud and embarrassed in equal parts.
* `case-day` (V `let` three times, +80): he works the whole drive, V helps, and he laughs about it at the tower.
* `stood-up` (-5).
* Rewards: the recipe card (`image`, kept in the chat thread), the open chair at his sister's table (a `history` line, no game effect).

Images (the top quest, five):
* `off-the-clock-phone.png`, sent at `phone`: a battered phone face-down in a glove box next to a sleeve of road snacks, game-look photo mode.
* `off-the-clock-roadside.png`, sent at the first temptation: a smoking car at the roadside at noon with a man waving, dust, a man's elbow on
  the passenger window of V's car.
* `off-the-clock-pot.png`, sent at `ridge`: a dented pot of red jambalaya on a camp stove on the concrete foot of a rusted water tower, a wooden spoon,
  steam, open desert behind.
* `off-the-clock-ridge.png`: two people seated on the footing of a water tower watching a golden desert sky, seen from behind, an open pot between them.
* `off-the-clock-card.png`, sent the next morning: a lined index card with a handwritten recipe and a coffee ring, "Tell Randy it's secret" added
  in smaller letters.

Build: `ask` as `text`, `meet`, `ride`, a suspend flag on River's `call-in` and `text` (small), timed `cast` incidents, `workspot` cooking (verify, hard
otherwise), `seat`, `together`, `image` x5, `history`.


His voice: a detective's plain questions, dry and self-mocking, practical, warm underneath. He asks "what did you see" before "what do you think". He never mentions a badge as if it still opened doors. He rides in V's car, so no line assumes his own vehicle. The kids are named only as Randy, Monique and Dorian, and only in the ordinary ways the profile allows.

Lines: see BOND_QUEST_LINES.md, River RW6

### River: scripted lines, holocalls and talk gaps

The scripted lines, the holocall scripts and the talk gaps (and the music and sound notes) of RW1 to RW6 are in [BOND_QUEST_LINES.md](BOND_QUEST_LINES.md), under River Ward, quest by quest.

### River reaches out first

| id | trigger | channel | opening line(s) | cooldown | the LLM knows |
|---|---|---|---|---|---|
| RWR1 | One game day after `sq021_sick_dreams` finishes | text | Joss says thank you. I can't say it right. So: thank you. | once | the missing boy case ending, Randy's state, what V saw |
| RWR2 | Bond level-up to 5 | text | Case file's open if you want to look. No pressure. | once per level | the ring case, what is already solved |
| RWR3 | Thursday dusk, after RW2 | text | Thursday again. Coffee's cold already. | 7 game days | the stakeout, the courier |
| RWR4 | V ends a fight with heat 4 or more | holocall | I heard it on the scanner. Is that you? Tell me it's not you. | 3 game days | the fight, any witnesses, V's health |
| RWR5 | After the dinner with Joss (`sq029_sobchak_romance`) | text | Joss wants to know if you're coming Sunday. I said I'd ask. So I'm asking. | 10 game days | the dinner, who was there |
| RWR6 | V enters the Badlands west of Santo Domingo at night | text | You're out near Red Peaks. Come by? Coffee on the stove. | 5 game days | V's location, the farm case if RW5 is done |
| RWR7 | Ten game days without contact | text | You alive? I'd check the cameras but I'm trying to be normal. | 10 game days | the last topic, any open promise |

### River hangouts

Same rules as Viktor: accepting is +6, completing is +2 to +8, repeatable with three variations, not quests. Locations are Badlands south and west of the Red Peaks side (never Rocky Ridge or Jackson Plains) and Santo Domingo. Exact spots captured in game later (verify each).

#### RWH1. Tin Can Alley

* **Location:** a dry gulch off the Red Peaks road (verify). **Unlock:** bond 2.
* **Invitation (text):** "Dry gulch off the Red Peaks road. Tin cans, two guns, one bad loser. Me."
* **Activity:** eight static targets (props, cans and bottles) at set distances, 30 s per round. V's hits are counted by the target `squad` going down. Score: 4 hits +2, 6 hits +4, all eight +8.
* **Twist:** a "witness" can is painted with a face and River refuses to hit it. V must hit it or he loses points for sentiment. He insists he has never missed on purpose.
* **Gap RWH1.g1** after round one. **Asks:** "Worst shot you ever took?" **Knows:** V's score, the gulch. **Secret:** his worst was a case he could not close. **Wants:** a story. **Idle:** `river`. **Resumes on:** V answers. **Branches:** V's story shapes his bet for the second round.
* **Variations:** (a) moving targets on a pulley rail, (b) dusk with one lantern, (c) pistols only.
* **Image:** `tin-can-alley.png`, a row of painted cans on a dry rock ledge at golden hour, one bullet-chipped, a rifle butt at the edge.
* **Build:** `squad` of static prop targets with a score read, `place`, `image`.

#### RWH2. The Friendliest Witness

* **Location:** a roadside diner on the main road through Santo Domingo (verify). **Unlock:** bond 3.
* **Invitation (text):** "A diner in Santo Domingo. Four witnesses, one stolen tip jar. Come hungry and suspicious."
* **Activity:** a staged minor theft. Four `cast` diners each give a statement to V (`archetype-talk`, ordinary NPC reactions). V names the thief by tag. +2 per sound question, +4 for the right accusation.
* **Twist:** the thief is the friendliest of the four. River's rule, "never trust the nicest one", is only right half the time. The jar was his own, a prank on the waitress, and River loves it.
* **Gap RWH2.g1** after the statements. **Asks:** "Who do you trust least in this room, and why is it the nicest one?" **Knows:** the four statements. **Secret:** he knew in the first minute. **Wants:** V's reasoning. **Idle:** seat `bar`. **Resumes on:** V names a suspect. **Branches:** a wrong pick earns a lesson, a right pick earns a grudging "keep this up and I'll hire you".
* **Variations:** (a) a lost dog (a prop leash), (b) a missing sandwich, (c) V sets the case and River investigates.
* **Image:** none.
* **Build:** `cast` x4 with trait tags (the `scene` primitive from T2), `archetype-talk`, `npc-react`.

#### RWH3. Scrapyard Appraisal

* **Location:** a wreck field in the Badlands south (verify). **Unlock:** bond 4.
* **Invitation (text):** "Scrapyard south of the city. Five wrecks, one quiz. Loser buys the coffee."
* **Activity:** five wrecks (`place`s). River quizzes V on make, year and why it ended up here, V answers by tag, and he scores. Each correct answer +2, up to +8.
* **Twist:** one wreck is an old patrol car with a sealed trunk. They open it together and it holds a dusty box of road flares and a pair of old handcuffs. River puts the cuffs in his pocket without comment. A scav claims the yard, V can talk (`npc-react`) or pay him off (`eddies`).
* **Gap RWH3.g1** after the fourth wreck. **Asks:** "Which one of these cars would you want to be buried in?" **Knows:** the wrecks. **Secret:** his car story. **Wants:** to hear V's taste. **Idle:** `lean`. **Resumes on:** V names one. **Branches:** the choice becomes a running joke.
* **Variations:** (a) night with a flashlight, (b) a rainstorm, (c) V quizzes River.
* **Image:** `scrapyard-appraisal.png`, a rusted sedan in a dry lot with a bullet-pocked patrol-car door, long shadows.
* **Build:** `place` x5, tags, `cast` scav with `npc-react`, `eddies`, `image`.

#### RWH4. Time Capsule

* **Location:** a pullout on the Badlands west road (verify). **Unlock:** bond 5.
* **Invitation (text):** "Badlands west road, a pullout with one tree. Bring something you won't miss and something you will."
* **Activity:** V chooses an item from the pack (a `check` of an item V carries) and a sentence for a note. River buries a rusted ammo tin with a spade. Burying counts +4, a thoughtful item +4.
* **Twist:** River admits he has never buried one and always wanted to. On the second visit they dig up the previous one and compare.
* **Gap RWH4.g1** at the burying. **Asks:** "What are you putting in, and who is it for?" **Knows:** the item, the tin, the tree. **Secret:** his own note is a single line. **Wants:** V to name an audience. **Idle:** `lean`. **Resumes on:** V names it. **Branches:** the recipient is stored in `history`.
* **Variations:** (a) digging up the last one, (b) burying something for Randy, (c) V buries a promise.
* **Image:** `time-capsule.png`, a rusted tin in a freshly turned patch of red dirt under a single tree, a spade stuck upright.
* **Build:** `check` of an item, `place`, `history`, `image`.

#### RWH5. Cover Story

* **Location:** a night market in Santo Domingo (verify). **Unlock:** bond 6.
* **Invitation (text):** "Santo Domingo night market. I'll give you an alias. Get a free coffee with it. If you can."
* **Activity:** River hands V a fake identity (a profession, a reason to be here). V must get a vendor (`cast`, `archetype-talk`) to give a free coffee with the story. Plausible +4, a free coffee +8.
* **Twist:** the vendor is a better liar than V and sees through it within a minute, but gives the coffee anyway, because the story was entertaining. River is delighted.
* **Gap RWH5.g1** after the attempt. **Asks:** "Which part of the story did you almost believe yourself?" **Knows:** the alias and the vendor's reactions. **Secret:** he learned to lie from the job and misses nothing about it. **Wants:** an honest answer. **Idle:** seat `stool`. **Resumes on:** V answers. **Branches:** the answer shapes the next alias he hands out.
* **Variations:** (a) V invents the alias, (b) River tries it and fails, (c) a rival cover story against a stranger's.
* **Image:** none.
* **Build:** `cast` vendor, `archetype-talk`, `npc-react`, `eddies` (optional), `seat`.

### River's gifts

| Tier | Categories | Reaction line | emotion | animation |
|---|---|---|---|---|
| Loved | real vegetables and spices for jambalaya, old case files or notebooks, a framed family photo | Where did you find this? Randy is going to lose his mind. | happy | river |
| Loved | a good thermos, a well-made camp stove | Somebody listened. Thank you. | nod | river |
| Liked | real coffee, hand-written notes, a book of maps | Good coffee. You know me. | nod | river |
| Liked | cooking tools, a sturdy flashlight | Practical. I like practical. | nod | river |
| Disliked | stolen goods, police-issue gear that is not his, trophies of kills | I can't take that. I know where it came from. | no | river |
| Disliked | cheap synthetic food, flashy bribes | You trying to buy me lunch? Don't. | disgust | river |

River's gifts to V, said when the pack hands the item over:

| Rarity | Gift | Line | emotion | animation |
|---|---|---|---|---|
| Common | a thermos of coffee | Cold by the time you drink it. Tradition. | happy | river |
| Uncommon | a pocket notebook | For the details. They are always the case. | nod | river |
| Rare | a compact camp stove | Don't burn the rice. | shrug | river |
| Epic | his worn leather jacket | It has seen things. Be nice to it. | nod | river |
| Legendary (iconic) | his old detective badge | It stopped opening doors. It still opens one for you. | sad | river |

---

## 12. Goro Takemura

Canon anchors: raised in the Chiba-11 slums (boys washing shirts in a canal with a chemical stench, a grandmother who told stories of kitsune, kappa
and bakeneko), picked by an Arasaka transporter as a child, soldier and then Saburo Arasaka's personal protector, who trained Sandayu Oda and
still mourns his lord. His loyalty to Arasaka is rooted in gratitude for regular meals, discipline and an education, which does not prove the
corporation kind. He wants Yorinobu exposed and respects Hanako's authority. He waits, observes and checks twice before acting, is sharply
unimpressed by Night City's processed food (he would cook onigiri with cod, grilled salmon or umeboshi if he had the time and ingredients), and
his formality makes room for a dry joke. He is out of place in street life and knows it. In V's story: meeting him to approach Oda (`q112_01`), the
Industrial Park, the Dashi parade, his hideout (`q112_04_hideout`), and rescuing Hanako (`q113_rescuing_hanako`). **Alive in this save**: Takemura
can die later in the main story, so every quest below also needs a `gate-plus` fact read that he is alive, a fact name to verify (a placeholder
`takemura-alive`, the real quest fact written by the game in the endgame or the Hanako branch to find). Missing data means no. Hanako is not used as
a body in any quest (her fate depends on the ending): she is a name he speaks, never a cast member. The game-placed Takemura stays at his story
places and only talks. The mod's copy meets V at Japantown or at V's flat. Ladder: 3, 4, 5, 6, 8, 10.

### T1. Honest Food (`takemura-honest-food`)

Gate: bond 3, `q112_04_hideout` (his hideout) finished, Takemura alive (`gate-plus` fact, name verify), none of his quests active. Any relationship.

Premise: Takemura has been in Night City long enough to be certain that its food is a crime against whoever invented it. He announces, as a formal
decision, that he will eat one honest meal and that V will choose where. It is both a test of V's judgement and the closest he comes to a joke.

Stages:
1. `summon`: **text + meet**. "I require a meal. An honest one. You will decide where one may be found." `meet` at a Japantown `place` (the
   market gate, the exact spot captured in game, verify the name of the market), within 3 game hours. Stood up: `no-meal`.
2. `choose`: **three counters**. Three `place` counters on the same street in Japantown, each with a `cast` cook (ramen, yakitori, a small sushi
   bar). V walks in front of each with him (`party`, `together` 2 game minutes at each) and chooses by entering. He watches the cooks' knife hands
   and says one word per counter. If V stalls for more than 15 game minutes he picks one himself and says he is not impressed.
3. `tasting`: **seat at the counter**. `seat` side by side, `together` seated 20 game minutes. The cook serves three dishes. Takemura rates each in a
   low voice to V, in the blunt dry way (the pack gives the ratings, never a recipe). The cook overhears at one point: his reaction is the
   ordinary NPC decision (`npc-react`, offended, flattered, cowers). V can smooth it over (tag `smooth`), say the truth (`truth`) or sit silent
   (`silent`). Takemura bows to the cook after the meal either way, to a depth that depends on the result.
4. `last-bowl`: if the cook ended up pleased, he brings a last small bowl that is not on the menu. Takemura eats it in silence, with the
   expression of a man at a funeral he is glad to attend. He pays double (the small "pay an NPC" flow, from his copy, not V).

Talk:
* the rating system: a number that is always three, and the reasons the number is never higher
* Chiba-11: the smell of the canal, what a meal meant when meals were not certain, said without self-pity
* his habit of watching a cook's hands before the food arrives
* gentle dry humour at his own expense when V asks what he eats at home
* he calls V "an acceptable guide" by the end, and the line is both a joke and a compliment

Outcomes:
* `honest-bowl` (+45): "You took Takemura to a counter in Japantown and the cook made him a bowl worth the trip." `history`: he calls it "the honest counter" and will go back.
* `thrown-out` (+25): the cook threw them out after the second rating. Takemura apologised to him in the street and bowed more deeply than he has to the corporation.
* `no-meal` (-5): "You wanted a proper meal and V did not come." He writes the city off a little further.
* Rewards: none (the casual one).

Images:
* `honest-food-counter.png`, sent after: three small dishes in a row on a lacquered counter, chopsticks laid exactly parallel across one bowl,
  steam, a paper lantern glowing beyond, a gloved hand holding the rim of the third bowl, game-look photo mode, no faces. Caption in his voice:
  "Adequate. The third was not."

Build: `meet` at a `place`, `party`, `together`, `seat` side by side at a counter, `cast` cooks with `npc-react`, the pay-an-NPC `eddies` flow, `image`,
`history`, `gate-plus` fact (verify).

Pins: the meeting point, the market gate in Japantown.

Lines: see BOND_QUEST_LINES.md, Takemura T1

### T2. Look Twice (`takemura-look-twice`)

Gate: bond 4, `q112_04_hideout` finished, Takemura alive (fact), none of his quests active. Any relationship.

Premise: Takemura has watched V cross rooms and decided that V looks once. A trained guard looks twice, and he intends to teach it in a way that
is not a lecture. He has V sit with his back to a street scene, changes it, and asks what is different.

Stages:
1. `lesson`: **talk**. At a bench in a Japantown square (`meet` at the `place`, evening). He explains the exercise in four sentences.
2. `watch`: **look**. V stands with him at the square's edge for 6 game minutes (`together`). A staged scene of five `cast` extras runs on a loop: a
   woman in a red coat who sits on a step, a man with a case who crosses the square three times, two boys who kick a can, a van that parks
   and leaves, an old man at a food stall. Each has a tagged trait the pack knows. V may walk the square (a freedom Takemura mentions only after).
3. `turn`: **sit with the back turned**. V walks to a bench 20 m away (`place`, `seat`) with the square behind them, for 4 game minutes. During that
   window the scene changes in three ways (the woman has moved, the van is now a different colour or a different van, the man with the case
   no longer carries it).
4. `quiz`: **four questions**. Takemura asks four things ("how many left the square", "what was different about the third crossing", "who was
   watching us", "what did the van do"). V answers by talk. The pack scores the tags V gives.
5. `watcher`: **small real thing**. One of the extras was a Tyger Claw lookout (a nameless `cast` man). Takemura points at him, says nothing,
   and lets V go and speak. The lookout's reaction is the ordinary NPC decision (he leaves, cowers, or draws and the squad of 1 turns hostile).

Talk:
* the lesson, rendered concrete: "you looked at the man who waved. The man who did not wave was the one who mattered"
* the dry apology when V gets one wrong, and the equally dry delight when V gets it right
* a memory he has not told anyone: the first time Saburo asked him what he had seen at a gala, and what he failed to see
* waiting as a skill, not a delay
* the lookout, handled gently by him if V scores high, with more warning if V misses it

Outcomes:
* `sharp` (4 of 4, +55): "Takemura taught V to look twice in a Japantown square, and V caught the man who was watching them." `history`: he sometimes says "look twice" at the end of a goodbye.
* `adequate` (2 or 3 of 4, +45).
* `blind` (0 or 1 of 4, +30): he says it is a beginning and means it.
* `walked` (V left before the quiz, +5).
* Rewards: none.

Images:
* `look-twice-square.png`, sent after: a Japantown square at dusk with hanging paper lanterns, a woman in a red coat on a step half hidden by a stall,
  a van with an open rear door, an old man frying at a stall, one man in a grey jacket at the edge who looks directly at the camera, game-look photo
  mode, slightly wide and cold.

Build: `meet`, `together`, `cast` x5 with trait tags and timed changes (new, small: a tagged-trait scene, see the summary), `seat`, answers as talk
tags, `npc-react`, `squad` of 1, `image`, `history`.

Pins: the meeting point, the bench in the Japantown square.

Lines: see BOND_QUEST_LINES.md, Takemura T2

### T3. Pincers (`takemura-pincers`)

Gate: bond 5, `q113_rescuing_hanako` finished, Takemura alive (fact), none of his quests active. Any relationship.

Premise: a guard who does not know the exits is only a man in a coat, and Takemura has decided to learn Japantown's back lanes the way he once
learned the Arasaka estate: every door, every roof stair, written in a black notebook. He walks V through them at dusk, naming each exit. At the
second lane he rests the notebook on a wall for ten seconds, and a thin teenager takes it and runs. He is not angry about the notebook. He is
angry that he did not look twice.

Stages:
1. `walk`: **walk the lanes**. `meet` at a Japantown `place`, `party` + `together` 10 game minutes through two lanes (`place` radius). He names each
   exit aloud and has V repeat them, quietly testing. This is the part that makes the chase possible: V now knows the lanes' shape too.
2. `snatch`: **foot chase with a cut-off**. A `cast` teenager (not a child, a thin seventeen-year-old in an oversized jacket) takes the notebook
   and runs a fixed route through the lanes (a `runner` on foot, 90 s, three route points). Takemura gives chase at once. V cannot out-run a
   copy that is already running, but V can cut across: Takemura calls the route turns through `remote` ("he goes to the market", "left, the
   stairs") and V must reach the cut-off `place` (a lane mouth) before the boy. At 3 m he stops and cowers (`npc-react`).
   * caught by V or Takemura -> `caught`
   * the boy reaches the crowd at the market `place` -> `lost`
3. `steps`: **sit on stairs and talk**. A quiet staircase (`place`). Takemura does not punish the boy. He sits him down and asks where he is from.
   V picks a tone (tags `scold`, `fed` where V pays for a steamed bun and a drink with the pay-an-NPC `eddies` flow, `walk` where V lets them talk).
   The boy's side is a `cast` extra's body language and Takemura's translation of it, not new voiced lines.
4. `redraw`: in `lost`, Takemura sits on the wall and redraws the lanes from memory with V correcting him, laughing quietly at himself.

Talk:
* the walk: exits as a vocabulary, "a lane has a front door and a back door and a third door nobody tells you about"
* the chase, in bursts: a trained man's breath control, "left", "the stairs", "do not shout"
* the boy and Chiba-11: what hunger does to the arithmetic of a rule, said in four sentences
* his honour about a theft: not the loss, the lapse, and then his forgiveness of the lapse
* in `lost`: "A good guard loses a notebook. A better guard has already memorised it."

Outcomes:
* `caught` and `fed` (+65): "You and Takemura ran down a thief through Japantown and he fed the boy." `history`: V is now "the second pincer".
* `caught` without the meal (+50): the boy was let go with a stern bow.
* `lost` (+35): the boy escaped. Takemura laughs quietly, then redraws the lanes.
* `stood-up` (-5).
* Rewards: none (he has no eddies to give and says so).

Images:
* `pincers-steps.png`, sent after: a thin teenager sitting on stone steps with a steamed bun in both hands, a tall man in a dark suit sitting one step
  above him looking at the street, a black notebook open on the step between them, lantern light at dusk, game-look photo mode, no faces.

Build: `meet`, `party`, `together`, `runner` on foot (new variant: a pedestrian on a fixed route, caught by distance), `remote`, `place` cut-off,
`cast` teenager with `npc-react`, the pay-an-NPC `eddies` flow, `image`, `history`.

Pins: the meeting point, the start of the lanes in Japantown.

Lines: see BOND_QUEST_LINES.md, Takemura T3

### T4. Word of Honour (`takemura-word-of-honour`)

Gate: bond 6, `q113_rescuing_hanako` finished, Takemura alive (fact), none of his quests active. Any relationship.

Premise: a minor security clerk in a corporation (a new man, nameless, harmless to canon, who knows Takemura only by reputation) approached him
last week and asked for help to leave the city. Takemura gave his word and does not ask a man what he carries when he has given his word. He cannot
move a frightened person through three districts alone and still watch the rear. He asks V.

Stages:
1. `ask`: **call-in**. The most formal call of the arc. `meet` at a Japantown tea shop `place`, within 2 game hours.
2. `clerk`: **meet the man**. The clerk (`cast`, becomes an `escortee`) sits at a back table with a suitcase. A short, tense talk. Takemura
   introduces V as "my second".
3. `walk`: **escort on foot, three legs**. From Japantown to Charter Hill, then Kabuki, then the pier at the Arasaka Waterfront (three
   `place`s, about 25 game minutes). Two relaxed patrols of corporate contractors (`squad` x2, unnamed, their identity left to the pack). Takemura's
   way is slow: wait, check twice, move. V may go `unseen` (the clerk follows, Takemura holds the rear) or take them in a fight. Midway the clerk
   breaks: "I want to go back." Tags: `push` (V pushes him on, the clerk bolts and the nearest patrol sees), `wait` (V waits two game
   minutes, he steadies), `rest` (a quiet beat in an alley, the clerk talks).
4. `pier`: **pay the boat**. A `cast` captain wants 1,500 eddies up front. Takemura offers his word, the captain refuses, V can pay
   (`eddies` to an NPC), haggle (`npc-react`), or pull rank by talk. The clerk boards.
5. `after`: **talk**. Takemura and V on the pier as the boat leaves. He explains what a word is.

Talk:
* before: why a promise to a stranger is the same as a promise to a lord
* on the route: his silence is a form of reassurance, his rare whispered instructions are all in the same four syllables
* at the break: he does not tell the man to be brave, he tells him what he is carrying, which is only a suitcase
* at the pier: Saburo, a line, and what he would have done with a clerk who asked his lord for help
* afterwards: that V was the right choice of second

Outcomes:
* `delivered` quietly (+80): "You and Takemura walked a frightened man across three districts and onto a boat without a shot." `history`: "the pier".
* `delivered` after a fight (+65): the clerk was boarded with a patrol behind them. He thanks V formally and then, privately, informally.
* `lost-him` (the clerk was taken, +25): a 7-day note. Takemura says it was his failure, not V's, and the sentence costs him.
* `stood-up` (-5).
* Rewards: none in eddies. The captain gives V an old paper harbour token (no game effect, an `image`).

Images:
* `word-of-honour-pier.png`, sent after: a small ferry at an Arasaka Waterfront pier at night, a figure with a suitcase climbing the gangway, a tall
  man in a dark coat standing at the end of the pier with his back to the camera, harbour lights, game-look photo mode.
* `word-of-honour-token.png`: a worn paper harbour token on a palm, a harbour light blurred beyond.

Build: `call-in`, `meet`, `escortee` (new: a `cast` person who follows V and Takemura to a place, can break and bolt, can be caught), `place` x4,
`squad` x2 relaxed patrols, `unseen` (new), choice tags at a timed break, the pay-an-NPC `eddies` flow, `npc-react` on the captain, `image` x2.

Pins: the meeting point, the tea shop in Japantown.

Lines: see BOND_QUEST_LINES.md, Takemura T4

### T5. Choose Your Ground (`takemura-choose-your-ground`)

Gate: bond 8, `q113_rescuing_hanako` finished, T4 finished (`after`), Takemura alive (fact), none of his quests active. Any relationship.

Premise: word of his current hideout has leaked, the one place in the city where he sleeps. Freelancers who hope the old bounty on a traitor still
means money will come tonight. He will not run from a place merely because it is inconvenient, and he will not leave V without telling V how to hold
a position properly. He asks V to be there, to choose a spot, and to learn.

Stages:
1. `warning`: **call-in**. "My address is known. I do not intend to move. I would be honoured if you would stand with me." `meet` at the hideout
   `place` (the one from `q112_04_hideout`, the layout and exact spot to verify in game), within 40 game minutes.
2. `ground`: **prepare**. Three marked positions in the building (door, stair window, roof edge, `place` x3). He explains each in a sentence and
   takes the front `post` himself. V chooses a spot. He moves a chair and a lamp so the dark falls where it helps.
3. `waves`: **defend in waves**. Three waves of freelancers (`squad` x3: four on foot at the door, a pair from the lane with a marksman on the
   opposite roof, two heavies through the back). Between waves 2 and 3 a `cast` negotiator walks up with his hands open and offers V 5,000
   eddies to step aside (talk): `refuse`, `listen` (V hears him out, Takemura waits), `take` (V takes the money and goes, Takemura holds alone).
   Success: all three waves down. Fail: V more than 100 m away while a wave stands.
4. `quiet`: **sit**. The room after the fight. `seat`, `together` seated 10 game minutes, tea made on a small stove. His formal thanks.

Talk:
* before: how to choose ground, three principles in a row, all of them about patience
* during: terse, his voice drops, "breathe, then move"
* with the negotiator: his formality at its most terrifying, three polite sentences
* afterwards: why he stayed, and why the hideout was never a hiding place but a post, and that V is welcome to it
* if V `took` the money: he says nothing for a full minute and then says "that was your decision" and walks out onto the roof

Outcomes:
* `held` and `refuse` (+80): "You and Takemura held his hideout against three waves and you refused the bounty hunters' money." `history`: the hideout is V's too.
* `held` and `listen` (+70): the same, and he says he understood the pause.
* `take` (-40): he fought alone and won. He will not hold it against V, and will not forget it either.
* `abandoned` (-15), `late` (-10).
* Rewards: a key to the hideout (`image`, `history`: V can sleep there, and so can a companion V sends). 2,000 eddies from the cleared freelancers' packs (`eddies` gift, he leaves it on the table without comment).

Images:
* `ground-doorway.png`, sent at the start: a hideout door and stair window at dusk, a single lamp moved to a corner, a pair of dark shoes by the
  door, game-look photo mode, no faces.
* `ground-roof.png`, sent after: two silhouettes at a rooftop edge in the early morning, a lantern burnt out, the city below.

Build: `call-in`, `meet`, `place` x3 for positions, `post` at the door, `squad` x3 with a marksman and heavies (needs the "never a heavy" rule
relaxed for this pack), a negotiator `cast` with talk tags and an `eddies` offer (small: a refuse/take flow), `seat`, `together`, `image` x2,
`history`.

Pins: the meeting point, Takemura's hideout.

Lines: see BOND_QUEST_LINES.md, Takemura T5

### T6. A Name for the Plaque (`takemura-name-on-plaque`)

Gate: bond 10, `q113_rescuing_hanako` finished, T5 finished (`after`), Takemura alive (fact), none of his quests active. Two variants (partner or
not).

Premise: he has never been able to mourn Saburo Arasaka in public, and he has never once marked the boys of Chiba-11 who were not chosen by the
transporters. Tonight he will hang one wooden prayer plaque at a small shrine in Japantown for his lord and one for the boys, with a brush, and he wants
a witness. "Not a guard. A witness." It is the nearest he comes to saying what V is to him.

Stages:
1. `ask`: **text**. "I would like a witness. Not a guard." `meet` at the shrine gate `place` in Japantown (the small shrine, the exact spot captured
   in game, verify any shrine in Japantown), at dusk. Stood up: `no-witness`.
2. `path`: **walk with stories**. `party` + `together` along the shrine path, three story `place`s: the stone foxes at the gate (the grandmother and
   the kitsune), a bridge over the canal (the kappa, and the Chiba canal), a wall (the bakeneko, and what he does not believe). 10 game minutes.
3. `rites`: **three stations at the shrine**. V stands at each for about 20 s (`place`, `check` of dwell): a water basin (he shows V how to wash
   the hands, `gestures`, hard: V's hands are not animated), a stick of incense (V lights it, narrative), and a writing table with plaques
   (`workspot` for him, brush in hand). He writes the first plaque for Saburo and reads it aloud, then the second for the boys. He asks V
   to speak one name aloud for a plaque of V's own. Tags: V gives a name (`name`, the pack records it as a `history` line without
   judging whom), or V declines (`none`, he does not press, and hangs a blank plaque for V "until you are ready").
4. `sit`: **sit on the steps**. `seat`, `together` seated 15 game minutes while the incense burns. A cat on the wall (a `cast` cat, verify a world cat
   can be spawned, else it is a line only). He does not look at it directly.
5. `charm`: **handover**. He buys V a small protective charm from the shrine's stall (the pay-an-NPC `eddies` flow, from his copy), wraps it in his
   handkerchief and gives it. Partner variant: one sentence about the mourning period, the nearest he comes to a confession. Friend variant: he bows,
   lower than for anyone.

Talk:
* the stories, as his grandmother told them, in short spare sentences, with his dry commentary at the edge
* Chiba-11 plainly: the canal, the transporters, what was taken and what he is grateful for without absolving it
* Saburo in one sentence and Hanako in one, no politics and no accusation
* the boys not chosen, as a list of nothing, and the discomfort of having been picked
* the bow: how it is done, why the angle matters, and a rare real smile when V gets it right
* if V gave a name: what he says to it, which is only "I will remember it with you"

Outcomes:
* `witnessed` with `name` (+100): "You stood with Takemura at a Japantown shrine while he hung plaques for his lord and for Chiba-11, and you gave him a name to remember with you." `history`: permanent, he asks after V's name now and then.
* `witnessed` with `none` (+95): the same, with the blank plaque. He never raises it again and never forgets it.
* `left` (V left during the rites, +40).
* `no-witness` (-10).
* Rewards: the charm (`items`, unverified, a junk item renamed only in the image) and the plaque image kept in the chat thread.

Images (the top quest, four):
* `plaque-rows.png`, sent at `rites`: rows of wooden prayer plaques on a shrine rack at dusk, black brush ink, a fresh one blank, paper lanterns, game-look
  photo mode, no faces.
* `plaque-foxes.png`: a pair of stone foxes with red cloth bibs at a shrine gate, incense smoke drifting across them, a tall man in a dark coat on the path
  beyond, out of focus.
* `plaque-canal.png`: a grey canal with a chemical sheen at dawn, boys washing shirts at the edge, a transporter's shadow across the bridge (a remembered
  scene, a soft over-saturated old-photo look, no faces).
* `plaque-charm.png`, sent after: a small brocade protective charm in a folded handkerchief on a palm, a cat's tail at the frame edge.

Build: `ask` as `text`, `meet`, `party`, `together`, `place` x6 (three story stops and three stations) with a dwell, `workspot` writing (verify), `gestures`, `seat`,
`cast` cat (verify), the pay-an-NPC `eddies` flow, `items` (unverified), `image` x4, `history`.


His voice: formal and precise, short declarative sentences, a dry joke now and then, food complaints delivered like reports. He bows rather than hugs. He says "adequate" for praise. He never uses slang correctly and knows it. Every quest still needs the "he is alive" fact (see Part B). Hanako is a name he speaks, never a body, never a voice.

Pins: the meeting point, the shrine gate in Japantown.

Lines: see BOND_QUEST_LINES.md, Takemura T6

### Takemura: scripted lines, holocalls and talk gaps

The scripted lines, the holocall scripts and the talk gaps (and the music and sound notes) of T1 to T6 are in [BOND_QUEST_LINES.md](BOND_QUEST_LINES.md), under Goro Takemura, quest by quest.

### Takemura reaches out first

| id | trigger | channel | opening line(s) | cooldown | the LLM knows |
|---|---|---|---|---|---|
| TR1 | One game day after `q113_rescuing_hanako` | text | The estate is quiet. I am not. Meet me when you can. | once | the rescue, Hanako's state (as the save shows it), his own oath |
| TR2 | Bond level-up to 6 | text | I have drunk proper tea for seven days. I thought of you. I do not know why. | once per level | tea, the last meal quest |
| TR3 | V consumes a heavily processed food item (event name to verify) | text | Do not tell me what you ate. Please. | 3 game days | the food item, his opinion of it |
| TR4 | Dawn (06:00 to 07:00 game time) | text | Sunrise. I take mine standing. You may sit. | 5 game days | the hour, V's last night |
| TR5 | V enters Japantown with bond 5 or more | text | You are in Japantown. I can smell your coffee from here. | 4 game days | the district, V's last visit |
| TR6 | After a high-heat incident involving corporate forces | holocall | I heard of the trouble. Report. Briefly. | 3 game days | the incident, V's wounds |
| TR7 | Bond level-up to 8, after T4 | holocall | I have been thinking about loyalty. I would like your view. Over tea. | once | the pier, the clerk, his word |
| TR8 | Ten game days without contact | text | I wished to say nothing and found it long. | 10 game days | the last topic |

### Takemura hangouts

Same rules. Locations are in Japantown (never Jig-Jig Street), Heywood's Wellsprings and Vista del Rey. Exact spots captured in game later (verify each).

#### TH1. Three Courtesies

* **Location:** a rooftop tea garden in Japantown (verify). **Unlock:** bond 2.
* **Invitation (text):** "There is a tea garden above a shop in Japantown. I wish to see whether you can be taught three courtesies."
* **Activity:** an old tea host (`cast`) tests V on three moments (arriving, receiving the cup, leaving). V's choices are tags. Each right courtesy +2, up to +6.
* **Twist:** the host is deaf to Takemura and answers only to V. He is annoyed. She asks V, in a gesture, for a haiku. V improvises through the LLM, and Takemura scores it in a low voice.
* **Gap TH1.g1** at the haiku. **Asks:** "A haiku. Seventeen syllables. Yours." **Knows:** the host's request. **Secret:** he has written exactly one in his life. **Wants:** V's attempt. **Idle:** seat `stool`. **Resumes on:** V speaks or 40 s. **Branches:** a good one earns his rare compliment, a bad one earns a bow of sympathy.
* **Variations:** (a) night with lanterns, (b) a second guest who does it all wrong, (c) V hosts and he is the student.
* **Image:** `tea-rooftop.png`, a lacquer tray with two tea bowls on a rooftop table, lantern light, a tall man's hands folded on the table edge.
* **Build:** `cast` host, tags, `seat`, `image`.

#### TH2. Enka Night

* **Location:** a karaoke bar in Japantown (verify). **Unlock:** bond 3.
* **Invitation (text):** "A small bar in Japantown has a machine that sings back. I am told this is entertainment."
* **Activity:** a dare exchange. Each takes turns. V's dares are small (one dumpling, one song choice), Takemura's is a verse. Each dare finished +2, up to +8.
* **Twist:** he insists on enka, the host's machine only knows pop, and he sings one verse anyway, flat and with total dignity. The bar goes quiet. A `radio` check reads the song V picks and he rates it out of three.
* **Gap TH2.g1** before his verse. **Asks:** "I will sing a verse. You will not laugh. Agreed?" **Knows:** the song, the bar. **Secret:** he rehearsed. **Wants:** V's promise. **Idle:** seat `bar`. **Resumes on:** V answers. **Branches:** a laugh costs a point and earns a bow, silence earns respect.
* **Variations:** (a) V sings first, (b) a duet, (c) a quiz of Japanese words.
* **Image:** none.
* **Build:** `cast` host, `radio` check, tags, `seat`.

#### TH3. Polite Trespass

* **Location:** a garden terrace in Vista del Rey (verify). **Unlock:** bond 4.
* **Invitation (text):** "There is a cherry tree in a corporate garden. It is closed. I would like to see it. Politely."
* **Activity:** V persuades a `cast` guard (`archetype-talk`, `npc-react`) to let them stay five minutes under the tree (`together` at the `place`). Success +6, a quiet leave +2.
* **Twist:** the guard recognises Takemura's bearing, bows deeply, and brings them tea. The terrace turns into a ceremony. If V fails, they walk back past the guard, who bows anyway.
* **Gap TH3.g1** under the tree. **Asks:** "What is the last place you were unwelcome and stayed anyway?" **Knows:** the guard's reaction. **Secret:** most of his adult life. **Wants:** a story. **Idle:** seat `lean`. **Resumes on:** V answers. **Branches:** a story earns one of his own.
* **Variations:** (a) the tree is bare in winter, (b) V is refused, (c) a second guard.
* **Image:** `trespass-tree.png`, a cherry tree on a corporate terrace, petals on a glass table, two cups of tea.
* **Build:** `cast` guard, `npc-react`, `together`, `place`, `image`.

#### TH4. The Right Coat

* **Location:** a tailor boutique in Heywood's Wellsprings (verify). **Unlock:** bond 5.
* **Invitation (text):** "I have one coat. A man with one coat is a man in trouble. Accompany me to a tailor."
* **Activity:** V picks a coat for him from three appearances (`outfit`). Takemura grades V's own look (`gear` check) and gives a score. A good pick +4, a matching look +4.
* **Twist:** the tailor (`cast`) prices the coat absurdly. V haggles with `eddies` as a student, and he watches silently. If the price drops by half, he says nothing and buys two.
* **Gap TH4.g1** at the fitting. **Asks:** "Which of the three would Saburo have approved?" **Knows:** the three coats. **Secret:** none of them. **Wants:** V's taste. **Idle:** `takemura`. **Resumes on:** V answers. **Branches:** a pick becomes his coat for the next hangout.
* **Variations:** (a) a suit, (b) a summer coat, (c) V is dressed instead.
* **Image:** none.
* **Build:** `outfit`, `gear` check, `cast`, `eddies`, `npc-react`.

#### TH5. Stillness

* **Location:** a promenade bench in Wellsprings (verify). **Unlock:** bond 6.
* **Invitation (text):** "I propose a contest. The one who speaks first loses. The loser buys tea."
* **Activity:** V and Takemura sit and say nothing for 10 game minutes (`together` seated, a silence rule: V's first line resets and loses). Completion +4, winning +8.
* **Twist:** a street performer (`cast`, `npc-react`) tries to make them laugh. Takemura does not move. The performer eventually bows and leaves.
* **Gap TH5.g1** after the contest. **Asks:** "What did you think about, in the silence?" **Knows:** the contest result. **Secret:** he thought of Chiba-11 and the canal. **Wants:** V's thoughts. **Idle:** seat `lean`. **Resumes on:** V answers. **Branches:** any answer is received without comment.
* **Variations:** (a) a longer silence, (b) a noisy day, (c) V is allowed one word.
* **Image:** none.
* **Build:** `together` with a silence rule, `cast` performer, `npc-react`, `seat`.

### Takemura's gifts

| Tier | Categories | Reaction line | emotion | animation |
|---|---|---|---|---|
| Loved | real food (rice, fish, umeboshi), fine tea, hand-made Japanese craft | This is real. You have my gratitude, and my apology to the city. | happy | takemura |
| Loved | a blade-care kit, a well-kept katana accessory | A man who cares for the edge cares for more than the edge. | nod | takemura |
| Liked | a good umbrella, a hand-written note, calligraphy supplies | Thoughtful. Correct. | nod | takemura |
| Liked | a clean folded handkerchief, a quality notebook | Precise. Thank you. | nod | takemura |
| Disliked | synthetic or processed food (instant noodles, protein bars), counterfeit Arasaka merchandise | Take it away. I will not insult it by eating it. | disgust | takemura |
| Disliked | loud jewellery, gambling tokens, street-fashion trinkets | I cannot accept this. It does not suit a man of my position. | no | takemura |

Takemura's gifts to V, said when the pack hands the item over:

| Rarity | Gift | Line | emotion | animation |
|---|---|---|---|---|
| Common | a rice ball wrapped in cloth | Eat it while it is warm. It is the only advice I give freely. | nod | takemura |
| Uncommon | a small sharpening stone | A blade is a promise. Keep yours honest. | nod | takemura |
| Rare | a cloth-wrapped tea set | For the days you do not hurry. | happy | takemura |
| Epic | a tailored black coat | Wear it where the edges of a room matter. | nod | takemura |
| Legendary (iconic) | his own tanto, the one he has trained with since the academy (item id to verify) | I have carried it for decades. It deserves a second life. | sad | takemura |

---

## 13. Songbird

Canon anchors: Song So Mi, a Brooklyn netrunner who took the jobs other runners called suicidal, drew the FIA's attention, and was recruited and bound to
the NUSA by Solomon Reed. She took an oath, learned to take orders after working alone, and spent years close to President Myers, whose use of her
Blackwall access damaged her body and sense of self. She had a relationship with Lucas (not expanded anywhere here). Reed's care for her and his
service to the state are tangled, Alex is a colleague from the same history whom she does not hand every secret to, and she finds trust hard because
every relationship has been a possible lever. She wants to live as a person who chooses, even about small things ("I want an answer I chose"). She
speaks with competence when she controls a system and in short sentences under strain, and in private moments she uses small sensory memories
instead of jargon: a fire escape, funk from a stoop, a scopdog seller, bonfire smoke. She lived in Night City on assignment near a neighbourhood
that reminded her of Brooklyn (which neighbourhood, verify).

**Branch and framing.** She leaves Night City in every ending of Phantom Liberty, and these six quests run only on the branch where V let her go. No
Songbird arc exists in `bridge/bond-arcs.mjs`. **A new arc entry is needed, a `gate-plus` item**: arc `songbird` with the quests
`ep1/quests/main_quest/q306_devils_bargain`, `q306_somi_epilogue` (the call from Alex asking to meet at a bar) and `q306_postcontent` (decrypting
a shard from Songbird and following its coordinates), and `notActive` prefix `ep1/quests/main_quest/q30`. **The freed-branch marker (verify
exactly)**: the pack starts only if `q306_somi_epilogue` and `q306_postcontent` are finished and `q306_reed_epilogue` was never begun (a `before`
read). Journal path names are known from `JOURNAL_QUEST_PREMISES`, but which of them exists only on the freed branch is a thing to check against
a real save. The Phantom Liberty finale paths (`ep1/quests/main_quest/q306`, `q307`) are already on the endgame guard, so a quest pauses there and
runs after the ending. **On the Reed branch there is nothing at all**, by the owner's decision of 29 Oct: no quest, no reach-out, no hangout and no gift. The same freed-branch marker gates all four.

**She is never physically there.** She reaches V by holocall (`call-in`, the mod's `holocall`), by Phone Chat text and images, and by her voice in
V's ear (`remote`, and the `johnny-voice` route for a voice with no body). Nothing in these quests uses `meet`, `party`, `seat`, `ride` with her as
a passenger, or any body of hers. The light-delay of a call from far away is flavour only: she says the call is older than it sounds, and no quest
adds an artificial wait to a reply (latency matters as much as FPS). Whether she is alive and where she is are not stated beyond canon, "somewhere
far away" is as far as any line goes (verify, see the summary). Whether V still carries the Relic on this branch is also unverified, so the voice
route is written as "her voice in V's ear" and never says how. V does the gameplay in Dogtown and the city. She is the one who plans, spots,
remembers and left things behind. Her Blackwall damage shows in the pacing of her lines (a pause, a lost word, "give me a few seconds"), never as a
joke. Ladder: 2, 3, 4, 5, 7, 9.

### S1. Ordinary Thursday (`songbird-ordinary-thursday`)

Gate: bond 2, the freed-branch marker (above), none of her quests active. Any relationship. Needs Holocalls and Phone Chat.

Premise: it is a Thursday where she is, and it has been a bad week. She does not want a mission, an exchange of secrets or a plan. She wants V to walk
down a street that sounds like a street she knew and tell her what is on it. She asks as if it were an embarrassing favour.

Stages:
1. `call`: **call-in**. At dusk game time. "Could we talk about something that doesn't have an extraction plan? Just for a minute."
2. `street`: **walk with a voice**. V goes to the neighbourhood that reminds her of Brooklyn (Heywood or another old district with stoops and fire
   escapes, verify, the exact street captured in game). Three `place`s on one street: a stoop, a corner stand, a block with a fire escape above. At
   each, a `remote` line, and she asks V what is there (V's words arrive as the next turn).
3. `funk`: **radio check**. At the corner she asks V to put something with a bass line on, in the car or on the pocket radio. A `radio` read
   (station, song) and her next line reacts to the song's name, whatever it is, with the delight or disdain she gives it.
4. `stoop`: **sit**. V sits on the stoop (`workspot` or a ground `seat`, `check` V stays at the place for 10 game minutes). She tells the Thursday
   she remembers: a fire escape, funk from a stoop, laughter in the street, a scopdog seller, bonfire smoke. It is not a story with a point.
5. `thursday`: closing beat. An `image` from her, sent after V leaves the street.

Talk:
* the rhythm of ordinary talk: she keeps interrupting herself to ask for one more detail
* the Brooklyn Thursday, in sensory fragments, and her annoyance that she is homesick for a street and not a person
* a lost word or two: she says she lost a word, laughs, asks V what it was, and V does not know
* guilt, small: "I used you, you know. I'd like you to know I know"
* nothing about the FIA, Reed or the Blackwall unless V asks

Outcomes:
* `thursday` (+35): "You walked a street that sounded like Brooklyn while Songbird listened from far away." `history`: she calls it "our Thursday".
* `cut-short` (+10): "V had somewhere to be." She says it is fine.
* `missed-call` (-5): she does not call again for a while.
* Rewards: none.

Images:
* `thursday-stoop.png`, sent at `thursday` with "Thursday.": a faded old photograph of a brownstone stoop at dusk, a fire escape above, kids and a man
  with a cart on the pavement, a smear of bonfire smoke across the sky, a soft pocket-camera look (grain, dated corner), no faces in focus.

Build: `call-in`, `place` x3, `remote`, `radio` check (existing song events), `workspot` or ground `seat` (verify), `check` of dwell time, `image`,
`history`. No new primitive.

Lines: see BOND_QUEST_LINES.md, Songbird S1

### S2. The Locker (`songbird-the-locker`)

Gate: bond 3, the freed-branch marker, none of her quests active. Any relationship.

Premise: before Reed brought her into Dogtown's mess she left a go-bag in a locker on a rooftop near the Black Sapphire (the roof, verify). Inside
there is no weapon and no deck, just an old music player with fourteen tracks she downloaded the night before she took her oath. She wants it to exist
somewhere outside her head. Her information about the patrols is seven weeks old, and she says so, and then forgets to account for it.

Stages:
1. `call`: **call-in + plan**. She gives V the roof and the locker number she remembers, and the patrol rhythm she remembers.
2. `approach`: **stealth with a spotter**. A `squad` of 5 Barghest-style guards (relaxed, two patrol points and a stair post) around the roof's
   building. `remote` lines count the patrol ("the third one turns at the count of twenty"). V must reach the roof `place` `unseen`.
   * her intel is old: a new post has appeared on the east stair, and she is wrong about the count. V adapts. She does not lie, she corrects
     ("that's new, I don't have that, go slow")
   * `unseen` holds -> `quiet`. A guard spots V -> a short fight on the roof or a retreat and a second try (`noisy`)
3. `locker`: **retrieve**. The locker `place` (inner radius 2 m, 6 s dwell). Her `remote` line is the quietest of the quest. V takes the
   player (`items`, an old music player, or the image only if no fitting item).
4. `listen`: **drive away and talk**. In the car (V's own, alone), she asks V to read the first track name. V reads it. She tells V what the track is
   (no real song title, the pack gives only the feeling of the track).

Talk:
* a spotter's cadence: counts, left and right, short orders, a calm that holds until it doesn't
* her admission of the stale intel and the way she hates being wrong
* what the player is, in a sentence, without saying why it matters, and then why it matters
* the oath and the night before it, said without self-pity
* a shortness of breath mid-quest, "give me a few seconds", then she carries on

Outcomes:
* `quiet` (+55): "You went up a Dogtown roof past a patrol for Songbird's old music player and never fired a shot." `history`: she asks V to keep the player.
* `noisy` (+40): the same with a fight on the roof, and she apologises for the intel.
* `empty-handed` (V gave up before the locker, +15): "V turned back." She says it was the right call.
* `no` (-5).
* Rewards: the music player (`items`, unverified) and the image kept in the chat thread.

Images:
* `locker-player.png`, sent after `locker`: a scuffed old music player and a pair of cheap earbuds on a metal shelf inside a rusted locker, a taped
  playlist on a scrap of card, a bare bulb above, game-look photo mode.
* `locker-roof.png`: a Dogtown rooftop at night seen from a stair, a guard's silhouette against a floodlight, a locker row, game-look photo mode.

Build: `call-in`, `remote`, `squad` with two patrol points and a stair post (needs the patrol record, as P4 already asks for), `unseen` (new),
`place` with inner radius and dwell, `items` (unverified), `image` x2, `history`.

Lines: see BOND_QUEST_LINES.md, Songbird S2

### S3. Return to Sender (`songbird-return-to-sender`)

Gate: bond 4, the freed-branch marker, none of her quests active. Any relationship.

Premise: she wrote something to Alex and cannot decide whether it is an apology or a request. She sends it as a voice message on a shard and asks V to
carry it to the Moth, where Alex stands behind the bar as Daphne. She does not want V to read it first. She wants V to listen to Alex's answer and
tell her exactly what was said.

Stages:
1. `text`: **text + shard**. Her message on the Phone Chat and an `image` of the unsent text on a screen.
2. `moth`: **go and wait**. The Moth `place` in Dogtown. Alex is game-placed and only talks. `check` of the hour: after 2 AM game time the bar
   has few patrons and she can talk (before that, V buys time with a drink at the bar, `seat`).
3. `deliver`: **item handover by talk**. V gives Alex the shard and speaks. Songbird listens in V's ear (`remote`) but cannot answer.
   Tags: V plays the message as it is (`as-written`), V softens it first (`softened`), V keeps it and says only that Songbird is alive (`withheld`).
4. `report`: **talk**. V tells Songbird what Alex said, exactly. The pack uses V's retelling as the turn note (it cannot read game dialogue).
   Her reaction is the heart of the quest.
5. `after`: she sends a last line to Alex through V, or does not. (`as-written` and `softened` only.)

Talk:
* before: "Don't tell me what it says. If you know, I'll hear you knowing it"
* Alex and what she means, as a person rather than a unit of the same history
* Reed, in one hard sentence, and Myers, in none
* the admission that she wants Alex to forgive her and also does not want to be forgiven for something she is not sorry for
* when V keeps the shard (`withheld`): she is furious for ten seconds and then very quiet

Outcomes:
* `as-written` (+50): "You carried Songbird's message to Alex at the Moth and told her exactly what Alex said." `memory-share`: the game-placed Alex (talk only) mentions the shard.
* `softened` (+45): she asks V what V changed, and what V changed it to.
* `withheld` (+20): she says she understands and does not, for a while.
* `no` (-5).
* Rewards: none.

Images:
* `return-unsent.png`, sent at `text`: a laptop-style screen at night showing a one-line message with a blinking cursor and the first word, "Alex,",
  nothing after it, an unlit room beyond, game-look photo mode.
* `return-shard.png`: a data shard on a palm over a bar counter, the Moth's neon blurred beyond, a glass at the edge.

Build: `text` + `image`, `place` at the Moth, `check` of the hour, `seat`, `remote`, talk tags for the handover, `items` for the shard (give and
take, unverified), `memory-share` (talk only), `image` x2.

Lines: see BOND_QUEST_LINES.md, Songbird S3

### S4. Left at the Burned Billboard (`songbird-burned-billboard`)

Gate: bond 5, the freed-branch marker, none of her quests active. Any relationship.

Premise: she wants to see one place in Night City again, a spot where she once parked to eat and watch the skyline, and she cannot remember the address,
only the landmarks. Some of them are wrong, because her memory is damaged and she knows it. V has to find the place by following her, with no pin on
the map.

Stages:
1. `call`: **call-in**. She sets the start: Dogtown's edge. "I can tell you what I saw. I can't tell you where it was."
2. `drive`: **navigate by memory**. V drives alone (`ride` without a passenger, no heat). Five `place`s in order, each unmarked: a burned billboard
   of a tyre ad she remembers on the left, a tunnel mouth with a broken light, a gas station with one working pump, a freeway on-ramp with a crushed
   sign, and the final overlook. She gives landmarks one at a time. A wrong turn is not an error: V describes what V sees and she corrects (a hint ladder:
   a hint per two game minutes, a third hint says the landmark outright). Some details she gives are wrong and she knows it a few seconds later.
   Limit: 30 game minutes.
3. `view`: **look**. At the overlook (an overpass with a skyline view on the edge of Santo Domingo, verify, the real spot captured in game), V stops
   and stays 5 game minutes (`check` of weather and hour). She asks V what colour the sky is.
4. `photo`: an `image` from her, an old photograph of the same view taken in daylight from the same spot.

Talk:
* the landmarks and the arguments with herself about them
* the meal she ate there, in four details: the paper wrapper, the smell of the vent, a radio playing something she cannot name
* the damage: what she loses at night, what she keeps, "I remember the road better than the day"
* a flash of humour at V's driving ("you're taking the long way, or I am")
* when V finds it: a silence and a short breath, and no thanks for a minute

Outcomes:
* `found` (+60): "You followed Songbird's memory across Night City to a skyline she used to eat in front of." `history`: she calls it "the overlook".
* `found` without any hint (+65): she goes quiet for a long time.
* `lost` (30 game minutes passed, +30): "She remembered a different city." She laughs and says "so I did live there".
* `no` (-5).
* Rewards: none.

Images:
* `billboard-approach.png`, sent at the first landmark: a burnt-out tyre billboard on a roadside at dusk, half its panels scorched, a freeway lane in
  the foreground, game-look photo mode.
* `billboard-skyline.png`, sent at `photo`: a skyline of Night City at golden hour through the railings of an overpass, an old date stamp in a corner
  and a pocket-camera look, someone's elbow on the rail.

Build: `call-in`, `remote`, `ride` without a passenger and `heat` read, `place` x5 with no map pin and a hint ladder (J6 already asks for a hint
ladder, no pin is a small addition), `check` weather and hour, `image` x2, `history`.

Lines: see BOND_QUEST_LINES.md, Songbird S4

### S5. The Mirror (`songbird-the-mirror`)

Gate: bond 7, the freed-branch marker, S4 finished (`after`), none of her quests active. Any relationship.

Premise: a young netrunner, nineteen, nameless, new, is held in the Longshore Stacks by a crew that sells runners' skills to whoever pays, and he is
being used the way she was. She can still listen to channels, and she heard it. "I can't reach him. You can." The quest is not a favour, it is the
first thing she asks that she cannot pretend is about herself.

Stages:
1. `call`: **call-in**. Her voice at its most controlled. She gives V the container stack.
2. `scout`: **stealth with a spotter**. The Stacks `place` (the Longshore Stacks container maze in Dogtown, the exact stack captured in game). A
   `squad` of 6 (relaxed, patrolling two lanes, a lookout on a crane). `remote` counts them. V works to the last container `unseen` or fights.
3. `dead-zone`: **no signal**. The last container is shielded. At its door the `remote` goes silent (a `dead-zone` flag on a `place`). V goes in
   alone. The boy (`cast`, a `hostage`) is in a chair with a rig, wide awake.
4. `rescue`: V reaches him (2 m, 5 s). He follows V (`escortee`). If combat starts the squad sends one man for him after 45 s.
5. `out`: **escort on foot** 150 m to V's car, squad remnants chasing. Her signal returns outside the door and she speaks to the boy herself
   through V's earpiece (her lines, a voice with no body). V drives him to a place she names, a contact in Dogtown (`ride`).
6. `after`: **talk**. In the car or on the call, the Mirror speech.

Talk:
* before: a plain tone, no jokes, nothing about herself
* at the dead zone: the last line before the silence is "I'll be right here" and the first line after it is "I know"
* to the boy: three sentences she has clearly rehearsed and one she has not
* after: what it is to be on the other end of a rescue, what she wishes someone had done, and what she did not do for herself
* the closest she gets to saying thank you: "You went where I couldn't. That's the whole job."

Outcomes:
* `saved` (+85): "You went into a shielded container in the Longshore Stacks and got a young netrunner out while Songbird waited outside the silence." `history`: "the Mirror".
* `saved-loud` (+75): the same with a fight, and she asks whether V is hurt.
* `too-late` (the boy died, +25): a 7-day note: she is quiet and then very calm.
* `abandoned` (-10).
* Rewards: none in eddies. The contact in Dogtown (a nameless woman) takes the boy in, a `history` line.

Images:
* `mirror-container.png`, sent at `rescue`: the inside of a shielded shipping container with a cot, a jury-rigged rig and a string of blinking
  LEDs, a ring of cables on the floor, a thin boy's hands on the arms of the chair, game-look photo mode, no face.
* `mirror-old-deck.png`, sent at the start: a beat-up second-hand deck on a desk under a bare bulb, taped corners, a handwritten label "SS", a
  mug of cold coffee, the look of a cheap phone photo.

Build: `call-in`, `remote`, `squad` with patrol lanes (as P4), `unseen` (new), `dead-zone` (new, small: a `place` that silences `remote`), `hostage`
using a `cast` extra (new), `escortee` (new), escort on foot, `ride`, `johnny-voice` route for her to speak through V's earpiece, `image` x2.

Lines: see BOND_QUEST_LINES.md, Songbird S5

### S6. Same Sky (`songbird-same-sky`)

Gate: bond 9, the freed-branch marker, S5 finished (`after`), none of her quests active. Two variants (partner or not).

Premise: she has not called for eleven game days, and when she does it is late and she sounds like she has practised. She asks V to go somewhere high
and look up. She wants to say the thing she has been rehearsing, and she can only say it under a sky.

Stages:
1. `call`: **call-in** at night. "Could you go somewhere high? And look at the sky? You don't have to say anything."
2. `climb`: **go high**. V reaches a roof or ledge (any `place` the pack accepts above a height, the best is the rooftop from S1 if played, verify the
   rooftop she shared with V in Phantom Liberty).
3. `sky`: **look**. `check` of weather (clear) and hour (night). If it is cloudy or day, the stage waits and she says she can wait, she is
   good at it, and the pack polls the weather only every 5 game minutes. `together` presence by V's dwell for 15 game minutes.
4. `ask`: **choice**. She asks the one thing: whether V wants her to keep calling, knowing she is afraid of using V again, knowing she cannot
   promise she will not. Tags: `stay` (V says to call), `free` (V tells her she can stop), `ask` (V asks where she is, she answers only that it is
   far and that the call is older than it sounds).
5. `send`: closing beat. An `image` from her side.

Talk:
* the guilt, in full sentences this time: what she took from V through the Relic, what it did to V, what she would do differently, what she cannot
  promise
* the wish to live as a person with choices, with a small example (she picked a name for a plant)
* the light-delay joke, once: "Whatever you say now is the past by the time it gets here. I like that it still counts."
* the sky: whether she is looking at the same one is left unsaid, in the exact sentence she uses (verify what to say)
* partner variant: one honest sentence about wanting, said without a pet name
* friend variant: "You're the only person who ever called me back"

Outcomes:
* `kept` (`stay`, +100): "You looked at the sky with Songbird from the other side of a call, and she will call again, never for a job." `history`: permanent, "the same sky".
* `free` (+90): she thanks V for letting her stop. She calls again within two game days.
* `quiet` (V said nothing, +60).
* `weather` (a day passed without clear sky, +40): she calls again when the cloud lifts.
* Rewards: the playlist from S2 if S2 was played (an `image` of the track list), and one last thing: a number V can ring that she never answers
  (a `history` line, no game effect).

Images (the top quest, four):
* `sky-roof.png`, sent at `sky`: a rooftop at night, a bare railing and a patch of clear sky, a bright moon above a skyline, a figure leaning on a
  parapet with a cheap earpiece, game-look photo mode.
* `sky-window.png`, sent at `send`: a small window at night with a dark field of stars beyond, a faint bright pinpoint low on one edge, a hand
  holding a mug on the sill. Variant B (to decide): a plain sea window at night. The image says nothing about where she is (verify).
* `sky-playlist.png`: a scrap of card with a handwritten list of fourteen tracks, a coffee ring over the last line.
* `sky-thursday.png`, if S1 was played: the stoop photo again with "Thursday" written across the back in pencil.

Build: `call-in`, `remote`, `check` of weather and hour with a slow wait (a 5-game-minute poll only while the stage waits), `place` high enough
(a rooftop `place` shipped with the pack), `together` by dwell, choice tags, `johnny-voice` route, `image` x4 with variants, `history`.


Her voice: short sentences under strain, competence when she controls something, small sensory memories when she is safe, and a pause before a hard admission. She never begs and never seduces. She is never physically present, so every line below is remote and the channel is named for each: **[call]** a holocall she starts (voice-only unless stated), **[ear]** her voice in V's ear (`remote` or the `johnny-voice` route), **[text]** a Phone Chat message. The animation column is `voice` for [call] and [ear], `text` for [text], and `songbird` (the idle shown in her call picture) only where a call is marked live. The light-delay is flavour in the words only, no line adds a wait. All of it is gated on the freed-branch marker from Part B.

Lines: see BOND_QUEST_LINES.md, Songbird S6

### Songbird: scripted lines, holocalls and talk gaps

The scripted lines, the holocall scripts and the talk gaps (and the music and sound notes) of S1 to S6 are in [BOND_QUEST_LINES.md](BOND_QUEST_LINES.md), under Songbird, quest by quest.

### Songbird reaches out first

All remote: a text, or a holocall she starts. None begins during a scene, a fight or a vehicle chase, and none fires on the Reed branch (the freed-branch marker gates them).

| id | trigger | channel | opening line(s) | cooldown | the LLM knows |
|---|---|---|---|---|---|
| SR1 | Bond level-up to 2, night | holocall | Hello. I woke up and wanted to say something. I don't have it yet. Stay a moment. | once | her condition, V's last topic |
| SR2 | V enters Dogtown | text | You're in Dogtown. Watch the north stair. Seven weeks ago it was empty. | 3 game days | the district, any recent patrol event |
| SR3 | V ends a fight with low health | text | You okay? I felt it. I know I can't. I'm saying it anyway. | 3 game days | the fight, V's wounds |
| SR4 | Dawn for V (06:00 to 07:00) | text | It's late for me. Early for you. I'm sorry I'm awake. | 5 game days | the hour, her light-delay joke |
| SR5 | V changes the radio station or song | text | Not that one. The one after. Trust me. | 5 game days | the song and station |
| SR6 | Ten game days without contact | text | Ten days is a long time. Not long enough for an apology. Long enough for a hello. | 10 game days | the last topic |
| SR7 | V enters Heywood or the Brooklyn-like block of S1 (verify) | text | You're near the stoops, aren't you. Sit a minute for me. | 4 game days | the district, S1 |
| SR8 | Rain begins where V is | text | It's raining there? I can hear it. Some of it. | 4 game days | the weather |

### Songbird hangouts

Same rules and the same freed-branch marker (none on the Reed branch). All remote: V goes somewhere, she is in V's ear or on the call. Locations are in Dogtown and Pacifica's inland side (never the coast). Exact spots captured in game later (verify each). Idle fields are V's own idle because she has no body.

#### SBH1. Shared Radio

* **Location:** the parking lot by the Dogtown Wall market (verify). **Unlock:** bond 2.
* **Invitation (text):** "Park somewhere and tune your radio. I'm going to pick a station by memory, and I'll be wrong."
* **Activity:** V flips through stations. She names the station she wants by description ("the one with the bad host"). A `radio` check matches her description to V's current station. A match +4, a song she likes +4.
* **Twist:** her memory is of a station that no longer exists. She picks a close match and is delighted anyway, or sulks. V can fake the name to make her happy (a tag), and she can tell.
* **Gap SBH1.g1** at the first song. **Asks:** "Is it the right song, or only the right mood?" **Knows:** the current song and station. **Secret:** she was trying to remember a person. **Wants:** V's take. **Idle:** V's idle in the car. **Resumes on:** V answers. **Branches:** the answer sets her next station request.
* **Variations:** (a) a talk station only, (b) a station that plays only one genre, (c) V chooses, she guesses the decade.
* **Image:** none.
* **Build:** `radio` check, `remote`, `place`.

#### SBH2. Card Count

* **Location:** a card table at Heavy Hearts in Dogtown (verify). **Unlock:** bond 3.
* **Invitation (text):** "I can't hack a table. I can count. Sit down at the card table and describe each hand to me."
* **Activity:** V plays small hands with a `cast` dealer (`eddies`, 100 to 300 stake). V describes the cards in words, she counts and advises. Win +4, avoid a loss +2, up to +8.
* **Twist:** the other player cheats. She spots it from V's descriptions and tells V in a calm voice to keep playing while she walks V through an exposure.
* **Gap SBH2.g1** after the third hand. **Asks:** "What do you see in his hands?" **Knows:** V's descriptions. **Secret:** she misses the thrill of being exactly right. **Wants:** V's eyes. **Idle:** seat `bar`. **Resumes on:** V answers. **Branches:** V's answer decides whether the exposure works.
* **Variations:** (a) a quiet table, (b) a crowded night, (c) V bluffs.
* **Image:** none.
* **Build:** `cast` dealer, `eddies`, `npc-react`, `remote`, `seat`.

#### SBH3. Window Shopping

* **Location:** the Grand Imperial Mall, Pacifica (verify). **Unlock:** bond 4.
* **Invitation (text):** "I want to choose things. Small things. Take me to a place with shops."
* **Activity:** V walks shop to shop. She picks one item per shop for V (a scarf, a cheap trinket). V buys one (`eddies`, small). A bought pick +4, a pick V wears (`gear` check) +4.
* **Twist:** she picks for V what she would buy herself and corrects it halfway, then picks the opposite, to see whether V resists. V can tell her which she wants.
* **Gap SBH3.g1** at the second shop. **Asks:** "Which would you buy if I were not here?" **Knows:** the item list. **Secret:** she never bought anything for herself. **Wants:** a refusal she can learn from. **Idle:** V's idle. **Resumes on:** V answers. **Branches:** V's honesty pushes her pick.
* **Variations:** (a) a food stall, (b) a toy aisle, (c) a stall of music.
* **Image:** `window-shopping.png`, a window display of bright scarves in a half-empty mall, a reflection of a figure in a jacket.
* **Build:** `place`, `eddies`, `gear` check, `remote`, `image`.

#### SBH4. Colour Hunt

* **Location:** the plaza by the Pacifica stadium (verify). **Unlock:** bond 6.
* **Invitation (text):** "Dogtown is grey. I'd like five colours. Find them for me, and tell me what they feel like."
* **Activity:** V finds five colours at five `place`s (a painted mural, a rusted blue door, a red stall, a green rag, a magenta scrap). At each, V describes it. Each colour +2, up to +8 with a bonus.
* **Twist:** the fifth colour is magenta, her own, and she reacts with silence and a laugh. She sends back the colour as an image.
* **Gap SBH4.g1** at the fifth colour. **Asks:** "What does this one feel like?" **Knows:** the colours found. **Secret:** magenta was the first thing she chose. **Wants:** V to say one honest thing. **Idle:** V's idle. **Resumes on:** V answers. **Branches:** the answer appears in a later text.
* **Variations:** (a) night, neon colours, (b) three colours only, (c) V picks them, she guesses.
* **Image:** `colour-hunt.png`, a grey wall with one magenta scrap of cloth on a rail, a stadium light flare.
* **Build:** `place` x5, tags, `remote`, `image`.

#### SBH5. Keep Watch

* **Location:** the rooftop of a water tower in Dogtown (verify). **Unlock:** bond 8.
* **Invitation (text):** "I haven't slept in two days. I can't tonight unless somebody keeps watch. Would you?"
* **Activity:** V stays on a rooftop `place` for 30 game minutes without combat and with heat 0 (a `check` of the combat flag and heat). She falls silent and breathes slowly. Completion +6, undisturbed +8.
* **Twist:** a stranger (`cast`) wanders up to the roof. V must handle them quietly (`npc-react`). She sleep-talks a few words, not a secret, and wakes embarrassed.
* **Gap SBH5.g1** on waking. **Asks:** "Did I say anything? Tell me honestly." **Knows:** what V heard (she said a street name and a name, the pack picks a harmless one). **Secret:** she dreams of the chair. **Wants:** honesty. **Idle:** V's idle. **Resumes on:** V answers. **Branches:** honesty earns a rare warm line.
* **Variations:** (a) rain, (b) a loud night, (c) V falls asleep and she watches.
* **Image:** none.
* **Build:** `place`, `check` of combat and heat, `cast`, `npc-react`, `remote`.

### Songbird's gifts

V can send a gift as a message with an item description, or leave something at a dead-drop she names. Reactions arrive as texts or in a call. Behind the same freed-branch marker: on the Reed branch there are no gifts either way.

| Tier | Categories | Reaction line | emotion | animation |
|---|---|---|---|---|
| Loved | music (a music player, a record, a playlist), a plant, a hand-written note | I'm keeping this. I haven't said that about anything in a long time. | happy | text |
| Loved | small sensory objects (a street-food wrapper from a stoop, a postcard of Brooklyn) | You remembered. Don't tell me how. | sad | text |
| Liked | real coffee, warm clothes, a book of maps | That's thoughtful. I'll use it. | nod | text |
| Liked | a simple handmade object | You made this. I can tell. | happy | text |
| Disliked | anything marked with a state agency or NUSA, trackers, anything that watches | Please take it away. I've had enough of being watched. | no | text |
| Disliked | pity gifts, medical devices she did not ask for | I don't need to be fixed. I need to be asked. | angry | text |

What Songbird gives V, left somewhere or sent:

| Rarity | Gift | Delivery | Line | emotion | animation |
|---|---|---|---|---|---|
| Common | a short playlist | text with a shard | Fourteen tracks. Not all good. Mine. | neutral | text |
| Uncommon | a print of a Brooklyn stoop | left at a locker she names | Thursday. Keep it flat. | happy | text |
| Rare | a small netrunner utility chip (item id to verify) | sent as a shard | It won't save you. It might save an hour. | nod | text |
| Epic | a reworked deck module of hers | left at a dead-drop | I wrote this on a bad night. It works on a good one. | sad | text |
| Legendary (iconic) | her first deck, the beat-up one labelled "SS" | left at the S2 locker | It was my first thing that was mine. Now it's yours. | sad | text |

---

---

## 14. Scripted lines, scripted holocalls and talk gaps (the system)

The owner's ask (29 Oct): quests must feel like real quests. Custom dialogue written ahead for the beats that need it, rendered ahead in each
character's cloned voice and shipped with the pack, scripted holocalls ("Panam calls: they took the car"), and in every scripted part the
player can still talk and ask anything through the mod's free LLM talk, with explicit gaps where the script waits and the character asks V
something back. The voice engine is OmniVoice Ultra: everything here is **pre-rendered voice (engine: OmniVoice Ultra)**, and the
lines in this document are text only, ready for that render. No audio is planned or generated now. The lines themselves are in [BOND_QUEST_LINES.md](BOND_QUEST_LINES.md), this section is the system they run on.

### 14.1 Which quests are scripted, and how much

| Kind | Which | What is scripted | Lines |
|---|---|---|---|
| Full | the top three of each ladder (levels 6, 8, 10, Jackie 4, 5, 6, Songbird 5, 7, 9): 30 quests | an opener (often a scripted holocall), beats at most stages, a closer per ending, barks for every checkpoint, 2 to 4 talk gaps | 25 to 45 each |
| Light | the lower three of each ladder: 30 quests | an opener, a closer per ending, barks, 1 or 2 gaps | 10 to 18 each |
| Free talk | everything between the lines, in every quest | nothing: the LLM, with the stage's notes | no limit |
| Reach-outs (section 15) | 86 triggers | the opening line only, then free talk | 1 or 2 each |
| Hangouts (section 16) | 50 hangouts | the invitation, the gap questions, a few activity barks | 3 to 8 each |
| Gifts (section 17) | 10 characters | one reaction per like tier, one line per rarity tier they give | 8 each |

A scripted line never answers V. It opens, moves the plot, reacts to the game (a squad down, a place reached) or closes. Anything V asks is
answered live, so a quest never feels like a cutscene the player cannot talk back to.

### 14.2 The line (`line`, new primitive)

Each line in a pack is data: a stable id (`P5.run.04`), the speaker, the trigger, the text, an emotion and an animation (section 19). The pack
ships the text. A render step (later, with the chosen engine) adds for each line:

* `audio/<engine>/<line id>.ogg`: the voice, rendered from the character's existing reference clips (the same references the live voice uses).
* `face/<line id>.json`: the face rows (mouth and emotion tracks) computed at render time by the same facial worker that runs for live speech
  today, so nothing is analysed at play time.

At play time:

1. **Preload at the stage start**: when a stage becomes current, the bridge hands the renderer (the hidden browser page that already plays all
   mod speech since 2026-10-22, `bridge/local-pcm-host.mjs`) the stage's audio files to decode (a few hundred KB), and reads their face rows. Nothing
   is loaded for stages that are not current.
2. **Play**: the trigger fires (a game event the stage watch already reported, or the runner's own step). The bridge asks the game for the speech
   lease of the speaking copy exactly as for a live reply (`mod/continuous-speech.lua`: volume, camera-relative pan and distance gain, or the
   `holocall` / `head` flag for a call or Johnny), the renderer plays the decoded buffer, and the face rows play against the renderer's heard
   cursor as live speech does. Subtitles come from the text. The line's gesture is chosen by `mod/companion-gestures.lua` from its category for that
   rig, the emotion drives the face plan through the existing emotion marks.
3. **Record**: a played line is written into the character's memory as her own words in this scene (the local store for the text providers, a
   note for Convai), so the next live reply knows what she just said.

**The prepared audio is always the voice.** A scripted line is played from its rendered file whatever live voice the player chose (Voxtral, Convai, Pocket or the local voice), so the player hears the rendered voice for the script and the chosen live voice for free talk. The mismatch between the two is accepted (owner decision of 29 Oct, 14.7). A line with no rendered file (a line added after the render, a missing file) is never handed to the live voice: it is shown as a subtitle and a Phone Chat line, and the missing file is logged as a pack error. No model call is made for a fixed line on any provider. The text never waits on audio.

**Latency**: a pre-rendered line starts as fast as the renderer can start a decoded buffer, about the 135 to 140 ms the live path measures for its
lease round trip and first sample (docs/OMNIVOICE_PCM.md), with no model call, no voice generation and no face analysis in front of it.

### 14.3 The scripted holocall (`call-script`, new primitive)

A scripted call is a sequence: who calls (the character, or V when the stage asks V to call), the picture (live, the mod's own holocall picture
of a copy filmed for the call, or voice only), its lines, its gaps and its end rule.

* **The character calls V** (`call-in`): the mod starts an incoming holocall in the game's call window (`HoloAudioCallLogicController`
  `ShowIncomingContact` / `StartAudiocall`, which the holocall feature already drives for calls V makes, docs/HOLOCALL.md). An incoming call the
  mod starts is not built and not verified: the fallback, always available, is a Phone Chat text with the call's first line and "call me", and the
  sequence plays when V calls. Quest calls of the game always win: a call is never started during a game call, a scene, a quest dialogue or a
  fight, and a pending scripted call waits.
* **During the call** the lines play with the `holocall` lease flag (full level, centred). At a gap the call stays open and V talks by push to
  talk or text, which is the ordinary holocall turn with the gap's notes.
* **The end**: the script hangs up after its last line (the mod ends the call), or V hangs up. Each call says what V hanging up early means
  ("tell me in person", "not now": the stage notes change, the plot moves to V's next turn with her).

### 14.4 The talk gap (`gap`, new primitive)

A gap is a state of the stage: the script has paused, usually right after a line where the character asked V something. While the gap is open:

* Every private turn of V's to that character (in person, on the call, in Phone Chat) carries the gap's note as the stage's volatile note:
  what she **knows** now (quest facts), what she keeps **secret** for now (her motive, said as "you have not told V yet: ...", which steers her and
  restricts nothing: she can still choose to say it), what she **wants** from V, and the choice tags she may add if V clearly agrees to one. One
  note, at most 600 characters, world tier, so the Mistral and Local AI prefix caches stay warm.
* Her **idle** plays (a seat, a lean, a cigarette, the car's wheel) through the existing idle and seat controllers, started at the gap's start,
  not per frame.
* **Resume cues**, whichever comes first: a choice tag in her reply that the bridge accepts (the existing tag rule: stripped, checked against
  V's words and the refusal screens), a timer in game minutes or seconds (checked at the next turn and by the stage watch), or a world event (V
  reached a place, V sat down, V got in the car, V left). The gap's `resumes on` names which.
* **Branches and flavour**: the tag picks the next lines (a different branch, or a line variant such as P4's "loud" argument). A gap can also
  store V's own words (trimmed to 80 characters) for a later line or ending memory ("you told me I lead like I drive").
* On the shared Convai key a gap works the same (V's own turns are model turns V started). If V says nothing, the timer resumes it, so a quest
  never stalls.

### 14.5 One voice at a time: a scripted line and live talk never talk over each other

The speech lease the game already holds per speaker is the arbiter, and the runner follows four rules:

1. A scripted line never starts while V is talking (the push-to-talk key held, the composer open with text in it) or while any reply of anyone
   is being produced or heard. It waits in a one-slot queue per character.
2. A live reply that V asks for while a line plays is generated at once (no latency is added), and its playback starts when the line ends.
3. **Barks can be dropped, plot lines cannot.** A bark that waited more than 4 s is dropped (the moment passed). A plot line waits, and after
   20 s it is shown as a subtitle and played at the next silence.
4. In a party or a group round, the other copies keep quiet while a scripted line plays (the same channel rule battle remarks use), and an
   automatic remark never fires inside an open gap.

### 14.6 What each provider gets

| | Convai (shared key) | Convai (own key), Mistral, Local AI, Custom |
|---|---|---|
| Scripted lines | always played from the rendered file, whatever the player's live voice, never a model call | the same |
| Gap notes | dynamic info, tags stripped | volatile note |
| A played line in memory | a note (Convai learns from real turns only) | a synthetic exchange in the local store |
| Talk in a gap | V's own turns | V's own turns |

The 500-a-day cap: scripted lines spend nothing. Only V's own talk in the gaps does.

### 14.7 Voice and language (decided 29 Oct)

* **Voice mix**: scripted lines are always played as the prepared audio, whatever live voice the player uses (Voxtral, Convai, Pocket, the local voice). A player on a cloud voice therefore hears the rendered voice in the script and their own voice choice in the gaps and in free talk. The owner accepts this mismatch. There is no subtitle-only fallback for any voice setting.
* **Languages**: English first. The scripted lines are written and voiced in English only for now, in every menu language. Other languages come later through the creator toolkit's translate and voice tools, which produce the `lines/<quest id>.<language>.json` files and their audio (section 18).

## 15. Characters reach out first (the system)

The characters text or call V first at prepared moments, and V's reply is live talk. The per-character trigger tables are in each character's
section ("reaches out first"): 86 triggers across the ten.

* **Trigger kinds**: a story moment (one of their quests finished, a main-story moment read from the journal inventory or a quest fact), a bond
  level reached, a time-of-day window, an event the mod already sees (a fight in their district ended, a high wanted level, rain, a radio song),
  and, gently, a few game days of no contact (never a guilt trip).
* **Checked at moments that already exist**: the level notice's watch, a journal-inventory change on a turn, a district change event, a fight's
  end, the game clock read at the 30 s ambush check that runs anyway when that setting is on, and otherwise the next time V opens the phone.
  Nothing polls for reach-outs.
* **Limits**: one reach-out per game hour across all characters, three per game day, each trigger once or on its own cooldown. Never during a
  scene, a quest dialogue, a game call, a fight or a vehicle chase, never while a story pack of that character is waiting on V (its own texts
  take that slot), and never for Jackie after The Heist, for Johnny outside V's head or for Songbird off the freed branch.
* **Delivery**: a text through Phone Chat (the appointment-event route, the fixed line, with a prepared image when the row names one), or a
  scripted holocall (`call-in`, section 14.3), or for Johnny his voice in V's head (`johnny-voice`, he just speaks up when V is idle).
* **Free on the shared key**: the opening is the fixed line, never a model turn. V's answer is V's own turn, with the trigger's note ("what
  the LLM knows when V answers") as a volatile note for that turn and the next two.
* **Off switch**: reach-outs are **off by default**, and work only while the Story packs setting is on (owner decision of 30 Oct, reversing 29 Oct), and one more row, **Characters text first**, turns them off for players who do not want a phone that buzzes. With Story packs off there are none.

## 16. Free-time hangouts (the system)

Attack on Titan 2's town life between missions: short, repeatable outings with one character, each at its own place, each with something to do.
The owner's rules: a different real location for every hangout, never two at one spot, a bond gain for accepting, fun with a mini-activity, a
twist and talk gaps, repeatable with variations, and none duplicating a quest.

* **How one starts**: she invites V (a reach-out style text or call, at most once a game day, more often at higher levels), or V asks ("want to do
  something?", "come to the lakebed") and the bridge offers the unlocked hangouts of that character by their invitation lines. Accepting is a
  choice tag. The hangout is an Immersive invitation to its place (`meet`), so travel, waiting and being stood up work as they already do.
* **Bond**: +6 when V meets her for it (the "met at an invitation" event of the bond model), plus the activity's own +2 to +8, inside a hangout cap
  of 20 points per character per game day (talk caps are separate). Stood up: -10 and one teasing line. Leaving early: the accept bonus only.
* **Repeats**: a hangout can run again after 3 game days, with one of its three variations (a different place point nearby, twist or activity
  data), never the same variation twice in a row.
* **Gaps** use the quest format (section 14.4). Each hangout has 1 or 2, and the character asks V something real in each.
* **Plot safety**: the character's gate (no quest of theirs active, not in a scene), and a hangout never runs while a story pack of that
  character is open.
* **Cost**: a hangout is a stage of a one-stage pack, with the same watch rules: one watch at most 1 Hz while it waits on the world.
* **Pin**: accepting a hangout puts a map pin on its place (`pin`, section 3), removed on arrival, on leaving early and when the hangout ends.

### 16.1 The registry: fifty hangouts, fifty places

| Id | Character | Hangout | Unlock | Place |
|---|---|---|---|---|
| PH1 | Panam | Fixing the Mackinaw | 3 | the garage of the gas station at Jackson Plains (verify the garage interior) |
| PH2 | Panam | Billboard Beers | 4 | the top of an old billboard over the highway north of Biotechnica Flats (verify one with a climbable frame) |
| PH3 | Panam | Stargazing at the Turbines | 5 | the base of the wind turbines south of the Kendachi farm road (verify the name) |
| PH4 | Panam | Diner Rules | 6 | the roadside diner at the Old Turbine Farm road junction (verify which Badlands diner has an interior) |
| PH5 | Panam | Dust Run | 8 | the dry lakebed east of Laguna Bend's dam road (verify, and kept away from Judy's hill) |
| JH1 | Judy | Roach Race | 3 | the arcade near the Kabuki roundabout (verify which Kabuki arcade has playable 2.x cabinets) |
| JH2 | Judy | Spot the Cut | 4 | a public braindance parlour in Kabuki, the cheap booths by the hour (verify one with an interior) |
| JH3 | Judy | Sound Hunt | 5 | Jig-Jig Street at night, from the north arch (verify) |
| JH4 | Judy | Skates at the Lake | 6 | the empty car park by the Laguna Bend boat ramp (kept away from J6's hill, verify) |
| JH5 | Judy | Repair Night | 8 | Judy's workbench in Lizzie's basement (the J3 stage there is talk only) |
| SHH1 | Johnny | Perimeter | 3 | Rancho Coronado, Santo Domingo |
| SHH2 | Johnny | Bet on the Bystander | 4 | Arroyo, Santo Domingo |
| SHH3 | Johnny | Wardrobe Veto | 5 | City Center, the shopping levels near Corpo Plaza, verify |
| SHH4 | Johnny | What Do I Know About You | 6 | Heywood, Wellsprings bar, verify |
| SHH5 | Johnny | Shakedown | 7 | Heywood, a street cart in Vista del Rey, verify |
| JWH1 | Jackie | Slowest Wins | 2 | Northside back roads |
| JWH2 | Jackie | Gone Fishing | 2 | Arasaka Waterfront, a pier |
| JWH3 | Jackie | Salsa for Beginners | 3 | Kabuki, a corner club, verify |
| JWH4 | Jackie | Grease Monkeys | 4 | Kabuki, a back-alley garage, verify |
| JWH5 | Jackie | Constellations of Northside | 5 | Northside, a rooftop |
| RH1 | Rogue | Spot the Plant | 3 | Charter Hill, a cafe terrace, verify |
| RH2 | Rogue | Table for Two | 4 | City Center Downtown, a busy restaurant, verify |
| RH3 | Rogue | Pretty Things | 5 | Charter Hill, a gallery, verify |
| RH4 | Rogue | Shake the Tail | 6 | City Center Downtown streets |
| RH5 | Rogue | Last Light | 8 | City Center Downtown, a high-rise bar, verify |
| KH1 | Kerry | Pick the Pick | 3 | North Oak, a vintage instrument shop, verify |
| KH2 | Kerry | Driftwood Fire | 4 | Pacifica coast, a beach, verify |
| KH3 | Kerry | Midnight Fridge Run | 5 | Kerry's villa, North Oak |
| KH4 | Kerry | Echo Pier | 6 | Pacifica, an old pier, verify |
| KH5 | Kerry | Garden Party Crashers | 8 | North Oak, a neighbour's garden, verify |
| VH1 | Viktor | Auscultation Walk | 2 | the noodle alley under the elevated rail in Little China (verify) |
| VH2 | Viktor | Fake Patients | 3 | the taco truck lot in the Glen (verify) |
| VH3 | Viktor | Roadwork | 4 | the courtyard loop around Megabuilding H10 in Little China (verify) |
| VH4 | Viktor | Name That Beat | 5 | a rooftop in the Glen at dusk (verify) |
| VH5 | Viktor | Brew and Haggle | 6 | the tea stall by the canal bridge in Little China (verify) |
| RWH1 | River | Tin Can Alley | 2 | a dry gulch off the Red Peaks road (verify) |
| RWH2 | River | The Friendliest Witness | 3 | a roadside diner on the main road through Santo Domingo (verify) |
| RWH3 | River | Scrapyard Appraisal | 4 | a wreck field in the Badlands south (verify) |
| RWH4 | River | Time Capsule | 5 | a pullout on the Badlands west road (verify) |
| RWH5 | River | Cover Story | 6 | a night market in Santo Domingo (verify) |
| TH1 | Takemura | Three Courtesies | 2 | a rooftop tea garden in Japantown (verify) |
| TH2 | Takemura | Enka Night | 3 | a karaoke bar in Japantown (verify) |
| TH3 | Takemura | Polite Trespass | 4 | a garden terrace in Vista del Rey (verify) |
| TH4 | Takemura | The Right Coat | 5 | a tailor boutique in Heywood's Wellsprings (verify) |
| TH5 | Takemura | Stillness | 6 | a promenade bench in Wellsprings (verify) |
| SBH1 | Songbird | Shared Radio | 2 | the parking lot by the Dogtown Wall market (verify) |
| SBH2 | Songbird | Card Count | 3 | a card table at Heavy Hearts in Dogtown (verify) |
| SBH3 | Songbird | Window Shopping | 4 | the Grand Imperial Mall, Pacifica (verify) |
| SBH4 | Songbird | Colour Hunt | 6 | the plaza by the Pacifica stadium (verify) |
| SBH5 | Songbird | Keep Watch | 8 | the rooftop of a water tower in Dogtown (verify) |

Checked: no two hangouts share a spot, and no hangout repeats its own character's quest activity. Close pairs kept on purpose, because the activity
differs: Judy's Spot the Cut (judging a BD's edits) and Takemura's T1 quest (judging three dishes) are both "judge it aloud" but never food and
film together, Johnny's Wardrobe Veto (he judges V's clothes) and Takemura's The Right Coat (V picks his coat) are mirror images, and the Laguna Bend
spots (Panam's lakebed, Judy's boat ramp, the J6 hill) are three different places a few hundred metres apart (verify the distances in game).
Panam's first draft of a bottle-shooting hangout was replaced by Billboard Beers because River's Tin Can Alley had the same activity.

## 17. Gifts both ways (the system)

The game has no gift-liking system of its own (the researcher found none), so this is the mod's. The item calls exist: redscript's
`TransactionSystem.GiveItem(player, ItemID.FromTDBID(t"Items.X"), 1)` is in the game's own scripts (verified in
`vendor/reference-game-scripts`), and the mod already moves eddies that way. Giving and taking non-money items is still unverified live
(`giveItem` / `takeItem` in the system doc's effects list).

### 17.1 V gives a gift

* V says it ("I got you something", "here, this is for you", and the 15-language screen Eddies uses for its money words). Only then, on that
  turn, the game reads V's inventory for the gift-able kinds (drinks, food, junk, clothing, weapons, cyberware items, quickhacks), one read, and
  the bridge matches the item V named against it. Several matches: she asks which.
* The item is taken (`takeItem` after a quantity check) and her reaction comes from her **likes table**: rules on the record's id prefix or tags
  (an alcohol drink, a `Nomad_` clothing piece, a `Cop_` piece, a cyberware item, an Arasaka-made thing) with example ids, so a whole category
  reacts the same and nobody has to list every item. The tier picks her scripted reaction line (each character's "gifts" table), then she talks
  freely about it.
* **Bond**: loved +8, liked +4, anything else +1, disliked -4 (a hurt, which fades). One gift a game day counts per character. Giving eddies stays
  the Eddies feature's own (its "gifts from V" story points).
* Johnny never takes anything: a gift to him is something V keeps, wears or drinks "in his name", and his reaction is to V doing it.
* Songbird is far away: a gift to her is a text with an `image` of it, or something V leaves at a place she names, a reaction only, no item moves
  (V keeps it).

### 17.2 She gives V a gift

* **Rarity rises with the bond**: common at levels 2 to 3, uncommon at 4 to 5, rare at 6 to 7, epic at 8 to 9, legendary (her iconic, or the most
  personal thing she has) at 10. Each tier once per save, given in person by a party copy, visitor or housemate (`giveItem` and her scripted tier
  line), at the first private turn after the level is reached when she is with V. A quest's reward is separate.
* **Already owned**: before giving, a quantity check. If V already has it (many iconics come from the story itself), she gives the tier's second
  choice, and the line says so ("you've got one of these, have this instead").
* **2.x quality**: weapons in 2.x carry a quality tier set when the item is made, and iconics are presets. A record given by id gets its default
  quality. Whether the mod can set a tier (for example a tier 5 copy of a weapon at level 10) is unverified: if it cannot, the tier is the record's
  own.
* **Clothing has no rarity in 2.x** (clothing lost its stats in 2.0), so a clothing gift's tier is how personal it is, not its stats.
* **Kerry's legendary gift is Guinevere** (owner decision of 29 Oct). It is added to V's garage with the game's own call (`garage`), for good: **this changes the player's save**, and the mod cannot take the car back. It is the only gift that does this, it is given once, and community packs never get `garage`. If V already owns the car, the tier's second choice is given instead.

### 17.3 The tables (record ids from the research pass, all to check in game)

The ids come from community item-id lists read on 29 Oct (gameplay.tips, gamertweak.com, xmodhub.com: the wiki refused the fetch). They were
not checked against this game build. Before anything ships, a small developer command checks every id of the allowlist against the game
(`TweakDB:GetRecord(id)`: a missing record is dropped from the table with one log line), the same way the ambush squad checks its fighter
records. Version tags: only the Phantom Liberty items were tagged by the sources (`PL`), the rest are marked base or unknown. The check is a task for the build and comes first: no pack uses a gift id before it has passed (owner decision of 29 Oct).

What she gives V:

| Character | Common (2-3) | Uncommon (4-5) | Rare (6-7) | Epic (8-9) | Legendary (10) |
|---|---|---|---|---|---|
| Panam | `Items.Nomad_01_Set_TShirt` | `Items.Nomad_01_Set_Boots` | `Items.Preset_Ajax_Moron` (Moron Labe) | `Items.Preset_Copperhead_Genesis` (PSALM 11:6) | `Items.Preset_Grad_Panam` (Overwatch, story-given in Ghost Town, so usually her bracelet from P6 and the second choice, see note) |
| Judy | `Items.LowQualityDrink11` (coffee) | `Items.BiotechUncommonMKI` (cyberdeck) | `Items.BiotechRareMKII` | `Items.BiotechRareMKIII` | `Items.StephensonLegendaryMKIV` (cyberdeck), her diving suit from Pyramid Song is story-only |
| Johnny | `Items.LowQualityAlcohol9` (Tequila Especial, "drink one for me") | `Items.Rockerboy_01_Set_Glasses` | `Items.Rockerboy_01_Set_Jacket` | `Items.Pants_02_basic_02` (Yoru No Samurai) | `Items.Preset_Silverhand_3516` (Malorian, story-given in Chippin' In: second choice needed) |
| Viktor | `Items.MicroGeneratorCommon` | `Items.SandevistanC2MK1` | `Items.KiroshiOpticsRare` | `Items.KiroshiOpticsEpic` | `Items.SandevistanC2MK4` (Dynalar Mk.4), or `Items.SandevistanC4MK5` (Falcon Mk.5, `PL`) |
| Jackie | `Items.Solo_01_Set_TShirt` | `Items.Vest_10_basic_02` (Valentinos straps) | `Items.Jacket_03_basic_04` (Valentinos jacket) | `Items.Jacket_17_rich_05` (Valentinos suede jacket) | none in Act 1: his La Chingona Dorada (`Items.Preset_Nue_Jackie`) is the story's gift in Heroes, so his top tier is a promise ("if anything ever happens, they're yours") that the game itself keeps |
| Rogue | `Items.Fixer_01_Set_TShirt` | `Items.Fixer_01_Set_Pants` | `Items.Fixer_01_Set_Coat` | `Items.Preset_Masamune_Rogue` | `Items.Preset_Liberty_Rogue` (Pride) |
| Kerry | `Items.Rockerboy_01_Set_TShirt` | `Items.Rockerboy_01_Set_Pants` | a Rockerboy piece not given by Johnny (verify the set's other records) | `Items.Preset_Overture_Kerry` (Archangel, check whether the story gives it) | Guinevere's keys (`garage`, allowed by the owner on 29 Oct: it adds the car to V's garage for good and changes the save), and if the call fails live Archangel moves up |
| River | `Items.Cop_01_Set_Glasses` | `Items.Cop_01_Set_Jacket` | `Items.Preset_Overture_Default_R` | `Items.Preset_Overture_Default_E` | `Items.Preset_Overture_River` (Crash, check whether the story gives it) |
| Takemura | `Items.TygerClawsJunkItem1` (omamori) | `Items.GoodQualityDrink6` (Te Sencha) | `Items.GoodQualityFood6` (nigiri) | `Items.ArasakaEpicMKIII` (Arasaka cyberdeck) | `Items.Preset_Katana_Takemura` (Jinchu-Maru) |
| Songbird | `Items.CyberdeckSplinter` (left in a locker) | `Items.ContagionProgram` | `Items.BiotechRareMKII` (a deck she used, left behind) | `Items.ContagionLvl3Program` | `Items.Preset_Power_SubmachineGun_Canto` (Erebus, `PL`) |

Gaps the research could not close: Kerry's own legendary item, Takemura's own pistol as an iconic, a Militech Canto Mk.6 id for Songbird, any
car (vehicles are `Vehicle.` records and go through `garage`). The 2.0 cyberware rework may have renamed the 1.x cyberware ids above: the
in-game check settles it.

What she likes from V (rules with example ids, the rest of each character's tiers are in their "gifts" table):

| Character | Loved (rule, example) | Liked | Disliked |
|---|---|---|---|
| Panam | nomad clothing (`Nomad_` prefix, `Items.Nomad_01_Set_Boots`), car parts and tools (junk, verify ids) | tequila (`Items.LowQualityAlcohol9`), beer | corporate clothing, Biotechnica or Militech branded items, synth food |
| Judy | cyberdecks and tech junk (`Items.BiotechUncommonMKI`), good coffee (`Items.LowQualityDrink11`) | food (`Items.MediumQualityFood4`), energy drinks (`Items.GoodQualityDrink3`) | Tyger Claw items (`TygerClaws` prefix), cheap beer (`Items.LowQualityAlcohol3`) |
| Johnny | rockerboy pieces (`Rockerboy_` prefix), tequila (`Items.LowQualityAlcohol9`) | anything Samurai, cigarettes | anything Arasaka (`Arasaka` prefix), militech gear |
| Viktor | cyberware (`Items.KiroshiOpticsEpic`), boxing things (verify ids) | a good drink | cheap chrome, synth booze |
| Jackie | tequila (`Items.LowQualityAlcohol9`), Valentinos clothing (`Items.Jacket_03_basic_04`), Valentino jewellery (`Items.ValentinosJewellery1`) | bike parts, a good meal | Maelstrom things, corpo clothes |
| Rogue | fixer clothing (`Fixer_` prefix), a fine pistol | an old-fashioned drink | anything Arasaka, flattery gifts |
| Kerry | rockerboy clothing, music junk (verify ids) | tequila, energy drinks (`Items.GoodQualityDrink3`) | cheap beer (`Items.LowQualityAlcohol3`) |
| River | real food and spices (verify ids), notebooks | police-surplus clothing (`Cop_` prefix) | cheap beer (`Items.LowQualityAlcohol3`) |
| Takemura | real food (`Items.GoodQualityFood6`), tea (`Items.GoodQualityDrink6`), Japanese charms (`Items.TygerClawsJunkItem1`) | a quality notebook | synthetic food and energy drinks (`Items.LowQualityDrink4`), cigarettes |
| Songbird | music (a track list `image`), something from Brooklyn | quickhacks | anything NUSA or FIA (no item moves, reaction only) |

## 18. Community quests: the pack format for other modders

Other modders can write bond quests, hangouts, reach-outs and gift tables as **data**, through the add-on API's content packs
(docs/ADDON_API.md, "Content packs (API 1.1)"), extended to **API 1.2**. A quest pack is a content pack: a folder with `convai-addon.json` and data
files, no code. The same format is the one our own quests ship in, and it is built to be written by a future quest-creator tool: plain JSON with a
published JSON Schema, stable ids, one file per quest, assets by relative path, lines kept apart from their audio, errors a UI can show beside
the field.

### 18.1 The folder

```
AiNpcCyberpunkModMyQuests/              installed like any add-on, in the CET mods folder
  convai-addon.json                     the manifest: "requires": {"api": "1.2"}, "content": {"bondQuests": "quests"}
  quests/<quest id>.json                one file per quest (schema bond-quest.schema.json, format 2)
  hangouts/<hangout id>.json            one file per hangout (the same schema, "kind": "hangout")
  reach-out/<character>.json            a character's reach-out triggers (schema reach-out.schema.json)
  gifts/<character>.json                likes and gives (schema gifts.schema.json)
  places.json                           the pack's places: id, point, radius, words (schema places.schema.json)
  lines/<quest id>.<language>.json      optional translations of the lines (the quest file holds English, and the mod's own quests ship English only for now, other languages come later through the creator toolkit)
  images/<name>.png                     prepared images, referenced by relative path (the source)
  <pack id>.archive                     the images cooked into a texture atlas by the pack builder (shipped, never hand-made)
  audio/<engine>/<line id>.ogg          optional, added by a later render: found by line id, never named in the quest file
  face/<line id>.json                   optional, made by the same render
  music/<name>.ogg, sfx/<name>.ogg      optional pack audio, referenced by relative path
```

Lines are separate from audio by design: a quest file names no audio file at all. A renderer (ours or a tool's) reads each line's id, text,
speaker and emotion, and writes `audio/<engine>/<line id>.ogg`. A pack with no audio plays its lines with the player's live voice (14.2).

### 18.2 The quest file (format 2)

The phase 1 pack format (system doc 7.2) is format 1 and stays readable. Format 2 adds the scripted parts. Its top level:

| Field | Rules |
|---|---|
| `$schema` | `"https://ai-npc-cyberpunk-mod/schemas/bond-quest-2.schema.json"` (shipped in the main mod as `schemas/bond-quest-2.schema.json`) |
| `format` | `2` |
| `id` | `<pack id>.<slug>`, lowercase letters, digits, hyphens and one dot, at most 64. Our own quests use the pack id `ainpc` |
| `version` | the quest's own semver. A saved quest in progress of an older version keeps running when the stage ids it is on still exist, else it ends with its `abandoned` ending |
| `kind` | `"quest"` or `"hangout"` |
| `character` | a roster profile key (`panam-palmer`). A pack can only write for characters the mod has. Characters a player made (`custom-`) and add-on speakers are not allowed in API 1.2 |
| `title`, `summary` | text, 80 and 200 characters |
| `requires` | the system doc's gate fields, plus `facts` (quest facts that must be set or unset), `before` (quests not yet finished), `window` (a story window, see `gate-plus`), `bond` (1 to 10), `after` (quest ids of the same pack) |
| `start` | channels, chance, `bringUp` (as format 1), plus `opener`: the line ids or the `call` that open it |
| `places` | ids from the pack's `places.json` that this quest uses, each with an optional `pin: true` for a meeting point that gets a map pin (section 3) |
| `stages` | 1 to 10 stages (below) |
| `endings` | each with `memory` (300 characters), `bond` (-30 to 150), `history` (a lasting line, 120 characters, optional), `rewards` (effects), `lines` |
| `images` | `{id: {path, caption, sendAt, variants}}`, paths inside the pack, PNG, at most 2 MB each. The builder cooks them into the pack's archive, and the validator checks the archive lists every image id |

A stage adds to format 1's `know`, `wants`, `choices` and `timeout`:

| Field | Rules |
|---|---|
| `gameplay` | a list of primitives from the closed list (section 21) with their data: `{"kind": "squad", "place": "barricade", "faction": "wraiths", "count": 4, "start": "relaxed", "waves": [...]}` |
| `lines` | the stage's lines: `{id, speaker, trigger, text, emotion, anim, variants}` |
| `call` | a scripted holocall: `{id, caller, picture: "live" or "voice", lines: [...], gaps: [...], endRule}` |
| `gaps` | `{id, after, asks (a line id), knows, secret, wants, idle, resumeOn: [{tag} or {timer} or {event}], branches}` |
| `music`, `sfx`, `situation` | section 19 |

A minimal JSON Schema excerpt (the shipped file is complete, and the validator in `bridge/bond-packs.mjs` is generated from the same rules):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://ai-npc-cyberpunk-mod/schemas/bond-quest-2.schema.json",
  "type": "object",
  "required": ["format", "id", "version", "kind", "character", "title", "requires", "start", "stages", "endings"],
  "additionalProperties": false,
  "properties": {
    "$schema": {"type": "string"},
    "format": {"const": 2},
    "id": {"type": "string", "pattern": "^[a-z][a-z0-9-]{1,23}\\.[a-z][a-z0-9-]{2,39}$"},
    "version": {"type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$"},
    "kind": {"enum": ["quest", "hangout"]},
    "character": {"type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,79}$"},
    "stages": {"type": "array", "minItems": 1, "maxItems": 10, "items": {"$ref": "#/$defs/stage"}}
  },
  "$defs": {
    "line": {
      "type": "object",
      "required": ["id", "speaker", "trigger", "text"],
      "properties": {
        "id": {"type": "string", "pattern": "^[A-Za-z0-9]{1,8}\\.[a-z0-9-]{1,24}\\.[0-9a-z]{1,4}$"},
        "speaker": {"type": "string"},
        "trigger": {"type": "string", "pattern": "^(start|timer:[0-9]+|(stage|place|squad|hostage|gap|choice|ending|runner|race|radio|npc):[a-z0-9:-]+)$"},
        "text": {"type": "string", "minLength": 1, "maxLength": 240},
        "emotion": {"enum": ["angry", "happy", "sad", "disgust", "fear", "surprise", "emphatic", "nod", "no", "shrug", "question", "neutral"]},
        "anim": {"$ref": "#/$defs/anim"}
      }
    }
  }
}
```

### 18.3 Validation the player and a tool can read

The bridge validates every pack once, at start, as content packs are today, and a pack that breaks a rule is **skipped whole**, never half
applied. Each error is an object a UI can show next to the field:

```json
{"file": "quests/ridge-run.json", "pointer": "/stages/2/lines/4/emotion", "code": "enum", "message": "emotion must be one of angry, happy, sad, disgust, fear, surprise, emphatic, nod, no, shrug, question, neutral", "value": "furious"}
```

`pointer` is a JSON Pointer into the file, `code` is stable (`enum`, `pattern`, `too-long`, `unknown-primitive`, `unknown-place`,
`unreachable-stage`, `loop-without-timer`, `asset-missing`, `asset-too-large`, `cap-exceeded`, `not-allowlisted`, `unknown-character`), and the
message is plain English. The game shows one notice per pack ("My Quests could not load: quests/ridge-run.json /stages/2/lines/4/emotion:
emotion must be one of ..."), the log has every error, and `node bridge/validate-pack.mjs <folder>` prints the same list for authors.

### 18.4 Safety limits

* **Data only.** A quest pack has no `init.lua` and no `bridge.mjs` for quests (a pack may still ship the tiny notice `init.lua` of the add-on
  API). Nothing in a quest file is code: triggers, conditions and effects are names from closed lists.
* **Allowlisted effects only**: the primitives of section 21, with caps a pack cannot raise: eddies at most 20,000 a quest (ours: the system cap of
  100,000), a squad at most 8 fighters a wave and 3 waves, factions from the ambush list, items only from the main mod's gift allowlist (no
  arbitrary `Items.*`), no `garage` for community packs, places inside the map's bounds and never inside a game quest's own area list.
* **The plot gate is the mod's, not the pack's**: the bridge adds the character's arc prefixes and the main-story guard to every pack, whatever
  it says.
* **Sizes**: a quest file at most 256 KB, at most 64 quests and hangouts a pack, images at most 2 MB each and 40 MB a pack, audio at most 400 KB a
  line and 150 MB a pack, text lengths as format 1.
* **No reaching across packs**: `after` only names quests of the same pack, places only the pack's own.
* **The player's switch**: Settings > Content packs, per pack, as today. Quests of a pack switched off never start, and one in progress pauses.
* **Versioning**: `requires.api` "1.2" for a quest pack. An older main mod skips it with the existing "needs a newer AI NPC Cyberpunk Mod" path.
  The schema's `format` moves only for breaking changes, and the bridge keeps reading the formats before it.

### 18.5 A tiny example pack

`convai-addon.json`:

```json
{"schema": 1, "id": "ridge-runs", "name": "Ridge Runs", "version": "1.0.0", "requires": {"api": "1.2"}, "speakers": [], "content": {"bondQuests": "quests"}}
```

`places.json`:

```json
{"places": [{"id": "old-pump", "point": [1834.2, -3920.5, 62.1], "radius": 12, "words": {"en": "the old pump station north of Rocky Ridge"}}]}
```

`quests/pump-breakfast.json`:

```json
{
  "$schema": "https://ai-npc-cyberpunk-mod/schemas/bond-quest-2.schema.json",
  "format": 2,
  "id": "ridge-runs.pump-breakfast",
  "version": "1.0.0",
  "kind": "hangout",
  "character": "panam-palmer",
  "title": "Breakfast at the Pump",
  "requires": {"bond": 3, "questsFinished": ["quests/main_quest/act_01/q104_02_av_chase"]},
  "start": {"channels": ["own", "phone"], "chance": 0.3, "bringUp": "You found a quiet place for breakfast and want V there.", "opener": ["RR1.invite.01"]},
  "places": ["old-pump"],
  "stages": [
    {
      "id": "breakfast",
      "know": "You are at the old pump station at dawn with two cans of beans and a camp stove.",
      "wants": "V's company, and an opinion on your cooking.",
      "gameplay": [{"kind": "meet", "where": "place:old-pump", "inGameHours": 2}, {"kind": "together", "radius": 5, "gameMinutes": 15, "seated": true}],
      "lines": [
        {"id": "RR1.invite.01", "speaker": "panam-palmer", "trigger": "start", "text": "Beans for breakfast at the old pump. Don't laugh, come eat.", "emotion": "happy"},
        {"id": "RR1.eat.01", "speaker": "panam-palmer", "trigger": "place:old-pump:arrived", "text": "Sit. Rate them honestly. Then lie.", "emotion": "happy", "anim": {"seat": "couch"}}
      ],
      "gaps": [{"id": "g1", "after": "RR1.eat.01", "asks": "RR1.eat.01", "knows": "breakfast at the pump", "wants": "a verdict on the beans", "idle": {"seat": "couch"}, "resumeOn": [{"timer": "gameMinutes:15"}]}],
      "next": "done"
    }
  ],
  "endings": {"done": {"memory": "You had beans with V at the old pump at dawn.", "bond": 8}}
}
```

## 19. Animation, music and sound

### 19.1 Animations

Three layers, all from pieces the mod already has, plus the game's own library where a quest needs a new pose.

| Layer | Field | What it uses | Real ids that exist today |
|---|---|---|---|
| Per scripted line | `anim.gesture` | a gesture category, played by `mod/companion-gestures.lua` from the character's or the rig's conversation clips | the categories of `assets/gestures/gestures.json`: angry, happy, sad, disgust, fear, surprise, emphatic, nod, no, shrug, question, neutral, idlebreak, with clips such as `stand__2h_on_hip__01__calm_down__happy__01`, `kerry__stand__2h_on_hip__01__shrug__01`, `johnny__stand__lh_pocket__01__rub_face__01` |
| Idle in a gap | `idle` | an idle workspot or a prop idle, or a seat | idle keys `judy`, `johnny`, `panam`, `kerry`, `takemura`, `jackie`, `misty`, `river`, `rogue`, `hanako`, `saul`, `reed`, `alex`, `songbird`, `generic_arms_crossed`, `generic_hips`, `generic_back`, `ripperdoc_arms`, `bodyguard_front`, `uscracks_cute` (paths in `gestures.json` `idleWorkspots`, for example `base\workspots\main_characters\panam\panam__stand__stand_around__01.workspot`). Prop idles: `johnny_smoke` (`Items.crowd_cigarette_i_stick`), `johnny_shades`, `judy_coffee` (`Items.takeout_cup_a_small`, the generic coffee workspot), `panam_beer` (`Items.crowd__bottle_k_beer`). Seats: `couch`, `chair`, `bar`, `stool`, `bed`, `chairsleep`, `lean`, `sink` (`seatWorkspots`, for example `base\workspots\common\bar_and_barstool\generic__sit_barstool_bar_lean_front__sit_around__01.workspot`) |
| By situation | `situation` on a stage or gap | a table that turns a situation into an idle and a gesture bias | `nervous`: idlebreak clips (shuffle, look around) and fear gestures. `celebrating`: happy gestures, a drink prop idle. `grieving`: sad gestures, a seat or `generic_front`. `angry`: angry gestures, `generic_arms_crossed`. `relaxed`: the character's own idle. `working`: a prop or workspot idle |

A workspot is played on a copy through the gestures' own invisible device entity, whose workspot resource must load
asynchronously (a synchronous one crashes the frame it streams in), and a body moved straight from one workspot to another can flash a T-pose,
so the controller exits first. A pose can be held still (a photo moment, a captive) with a per-entity time dilation near zero while the face
keeps moving. Situations also set the face through the game's facial reaction feature, which the face code already drives.

New poses the quests ask for, all from the game's library and all unverified until someone finds the workspot path in the archives (the mod's
earlier gesture and seat research did the same with WolvenKit, read only): lying on the back (P3 hangout, PH3), sitting on the ground or a ledge
(P6, J6, several hangouts), prone with a rifle (P2), a mechanic under a car or at an engine (PH1, Jackie's garage hangout), a kneeling captive
(J5, K4, V5, S5), playing a guitar (Kerry, verify that his villa's guitar workspot is usable outside its quest), cooking at a stove (RW6),
dancing (Jackie's salsa hangout), lifting weights (JW4). A pose that cannot be found falls back to the nearest idle, and the line still plays.

### 19.2 Music

| Field | Meaning |
|---|---|
| `music.source` | `"radio:<station name>"` (switch V's car radio or pocket radio to a game station), `"file:<path>"` (a track the pack ships), or `"game:<event>"` (a game music event, unverified) |
| `music.start`, `music.stop` | triggers, the same vocabulary as lines (`stage:dawn:enter`, `gap:g2:resume`) |
| `music.fadeIn`, `music.fadeOut` | seconds, 0 to 10 |
| `music.volume` | 0 to 1, and `duck: true` lowers it under any speech |

How: a pack file plays through the same renderer as the voice, as a second, non-positional stream at the music volume, ducked while anyone
speaks (the renderer already mixes and pans speech, so this adds no game work). A game station: the radio read (`mod/media-song.lua`) already
follows the game's song events, and switching a station is a known vehicle radio call (`ToggleRadioReceiver`, `SetRadioReceiverStation(index)`, and
`RequestSongOnRadioStation(station, song)` to queue a song on a station, all callable from script, the pocket radio's equivalent unverified). A game music event through the audio system is the least certain: the `mus_*` events are start and stop pairs
(open-world faction states, buskers, atmospheres, quest cues and stingers), nobody has started one from script in this mod, and the score is
state-driven and may fight a cue, so quests here use it nowhere: they use V's own radio (P6, RW6, Songbird's shared radio) or a pack file (J6's BD music).

### 19.3 Background sound

| Field | Meaning |
|---|---|
| `sfx[].source` | `"file:<path>"` (a pack file, any modder can supply one) or `"game:<event>"` (a game sound event, verify each id) |
| `sfx[].at` | `"v"`, `"copy"` (the speaking copy), `"place:<id>"`, or `"bed"` (non-positional) |
| `sfx[].loop`, `start`, `stop`, `fadeIn`, `fadeOut`, `volume` | as music |

How: pack files go through the renderer too. A `bed` loop (rain on a roof, a club's bass through a wall, crowd murmur) is a stereo stream with no
position, which costs nothing in the game. A one-shot at a copy uses the speech lease's position (the same pan and distance the voice gets). A
loop at a place needs that place's position relative to the camera while it plays: a position read at most 4 times a second, only while the loop
plays and only within 60 m (beyond that it is silent), which is the one recurring read this section adds, and quests here keep such loops rare
(Judy's rig hum in J5). Game sound events play flat through `Game.GetAudioSystem():Play(event)`, on an entity with `Play(event, entityID, emitterName)` or a queued
`SoundPlayEvent` (stopped with the matching `SoundStopEvent`), and at a bare point only from an invisible helper entity placed there. The
library is large (about 20,000 event names: `amb_*` ambiences, `ono_*` vocal sounds, `dev_*` devices, `ui_*` jingles such as
`ui_jingle_quest_new`, `w_*` weapons, `v_*` vehicles). A wrong name plays nothing and says nothing, and a positional loop never stops by itself,
so the reaper stops every loop it started. The mod already reaches the audio system for add-on lines (`mod/game-dialogue.lua`). Each event a
pack names is checked once in game before it ships.

**About Audioware**: the mod no longer requires it (docs/OMNIVOICE_PCM.md, 22 Oct): all mod speech plays through the bridge's renderer, and the
bridge clears what older versions left under `r6/audioware`. So quest audio uses the renderer and adds no dependency. Audioware stays a possible
route only for sound that must be attached to a moving world object for a long time, which no quest here needs.

### 19.4 Unverified, in one list

The workspot paths of the new poses, the station-switch call, every `game:` sound and music event name, a mod-started incoming holocall, the
captive pose, playing a guitar or cooking outside their quests, the position-read cost of a place loop (to be measured with the stage clock).

## 20. The sameness check

All sixty, after the fixes. The rule: no two quests share a core loop and a setting, every character's six use different main types, nothing is
a plain fetch or kill job.

| Id | Title | Bond | Core loop | Main setting | Gameplay types |
|---|---|---|---|---|---|
| P1 | Coffee at the Sunset | 3 | dawn walk around Rocky Ridge, then sit for the sunrise | Sunset Motel, Rocky Ridge | walk, `together`, sit, `image` |
| P2 | Toll on the Old Highway | 4 | V talks down a Wraith toll while she covers from a ridge | old highway south of Rocky Ridge | `post` overwatch, `npc-react` negotiation or `squad` fight, `ride` |
| P3 | Nomad Driving School | 5 | a timed checkpoint route with her grading, then she drives it | Badlands riverbed, turbines, rail bridge | `ride` with checkpoints and time, `chauffeur`, bet |
| P4 | Ghost on the Wire | 6 | plant a device on a relay unseen, she waits as getaway | relay mast above Vasquez Pass | stealth (`unseen`), `post`, `remote`, escape `ride` |
| P5 | The Long Way Home | 8 | lead a clan supply convoy home, choose around or through an ambush | SoCal border crossing to the Aldecaldo camp | `convoy`, `squad` with vehicles, reroute choice |
| P6 | Nowhere in Particular | 10 | a night drive with no destination, her confession, a dawn keepsake | outside the city, a Badlands overlook of V's choice | `ride` without destination, `radio` check, ground sit, `items` |
| J1 | Spare Parts | 3 | walk the stalls and haggle for a matrix | Kabuki Market | walk, `cast` vendor haggle, `items` |
| J2 | Door Duty | 4 | stand Lizzie's door for an hour through three incidents | Lizzie's Bar door, Little China | timed presence with `cast` incidents, `npc-react`, sit |
| J3 | Stolen Signal | 5 | chase a courier bike carrying the dolls' testimonies | Kabuki to a Northside warehouse | `runner` chase, `squad` branch, keep-or-burn choice |
| J4 | The Claws Come Calling | 6 | hold Lizzie's street front against three Tyger Claw waves | Lizzie's street front | `squad` waves, `post`, `cast` allies, aftermath walk |
| J5 | No More Dolls | 8 | get a captive out of a scav XBD den, quiet or loud | a dead parking garage, Northside | `unseen` or `squad`, `hostage`, escort, sit |
| J6 | Grandpa's Recording | 10 | a braindance as images, then recreate his frame on the hill | Judy's flat, then Laguna Bend | `image` sequence, `chauffeur` in her van, photo moment `place` dwell, ground sit |
| SH1 | What They Say About Me | 3 | street poll of three kinds of strangers, scored by Johnny | Kabuki, Corpo Plaza, Japantown on foot | walk, `archetype-talk`, talk |
| SH2 | Dial Surf | 4 | judging the radio with a figure on the rail, then silence | V's balcony, Megabuilding H10, Kabuki | quiet hangout, `radio` check, `together` |
| SH3 | Field Manual | 5 | three soldier's rules applied in a scav depot | ruined depot, Badlands (Jackson Plains) | ride, stealth into combat, `squad`, `unseen` |
| SH4 | Licensed to Thrill | 6 | tail a licensing rep's car, then confront him | Japantown -> City Center -> Watson | tail (a reverse chase), negotiation by talk, `gear` check |
| SH5 | The Count | 8 | walk to a shrine and sit beside a grieving stranger | memorial lookout over Corpo Plaza | walk, sit, `cast`, `npc-react` |
| SH6 | Soundcheck | 10 | an empty stage at dawn, and a question asked instead of taken | Totentanz stage, Westbrook | timed presence, choice talk, `johnny-voice` |
| JW1 | Not Quite Mama's | 2 | taste three noodle stalls for one that tastes like home | Little China stalls | walk, sit, phone-half call |
| JW2 | Sticky Fingers | 2 | foot chase of a pickpocket who took his gold cross | Kabuki Market stalls and rooftop walkways | chase on foot, `npc-react`, buy-back |
| JW3 | Come Home, Kid | 3 | talk or sneak a Heywood kid out of Maelstrom recruiters | Northside Maelstrom yard, Kabuki Metro | ride, stealth or talk, escort, `squad` |
| JW4 | Wraps | 4 | lift, wrap, and corner his own bout | V's gym, Viktor's clinic, Northside pit | timed presence, friendly bout, `eddies` bet |
| JW5 | The Drink with My Name | 5 | rehearse a legend's entrance, take the photo, name the drink | the Afterlife, Little China | walk, photo moment, `cast`, talk |
| JW6 | The Bottle | 6 | the night before the Heist: Misty, Mama's call, a roof, a sealed bottle | Misty's, a Little China rooftop | talk, phone-half call, sit together |
| R1 | Terms | 3 | negotiate the fee, then carry a bar tab to an old solo | Afterlife booth, Kabuki noodle stall | negotiation with her, item handover, errand |
| R2 | Hiring Day | 4 | judge three hidden-truth candidates for a job | Afterlife private booth | `cast` interviews, judgement by talk, next-day text |
| R3 | Four Questions | 5 | extract a defector on a route chosen by her four questions | Northside drop house -> Afterlife | escort on foot, stealth, `post` + `remote` |
| R4 | Say Left | 6 | drive her car by voice only, no map, to a rail over the water | Watson streets, waterfront lot | hidden-route `ride`, weather `check`, `chauffeur` |
| R5 | Who's Listening | 8 | find the leak among three staff before the other side comes | Kabuki capsule hotel | observation watch, `npc-react`, short defence, `post` |
| R6 | What I Never Said | 10 | say it aloud while she folds laundry, and hear his answer | all-night laundromat, Little China | sit together, `johnny-voice`, walk |
| K1 | Caliente Mornings | 3 | go find a diner from the poor years, and have coffee on its corner | North Oak -> a Watson or Westbrook corner | `chauffeur` in Guinevere, sit together |
| K2 | Incognito | 4 | get Kerry through a crowd to a stall without a raised phone | Japantown night food street | social stealth, `outfit`, sit together |
| K3 | Guinevere Wants to Run | 5 | his Aerondight against V's car for the choice of station | North Oak gate -> Atlantis Stadium lot | `race`, `check` (heat), radio stake |
| K4 | Bootleg | 6 | Kerry is the bait at the front door while V frees his guitar tech | closed theatre, Westbrook | `hostage`, `unseen`, `squad` of fans, escort |
| K5 | Tomorrow in Tokyo | 8 | be near but not too near while he takes a call from his children | the marina, his boat | sit, `apart` (privacy ring), pier sit |
| K6 | First String | 10 | find a lost first guitar, then let it stay lost | pawn and repair shops, a Watson underpass | investigation by `archetype-talk`, hint ladder, `eddies` |
| V1 | Ringside | 3 | spectate three amateur bouts and call punches | old Devils gym, Watson | hangout, `bout` spectating, small bet |
| V2 | Night Calls | 4 | drive Viktor to three after-midnight house calls, pay a tab | Kabuki, Northside, Heywood | ride, errand, talk, eddies |
| V3 | The Third Card | 5 | keep Misty's copy in her chair with a tarot reading while he finishes a gift | Little China night market | decoy, sit, talk, craft reveal |
| V4 | Off the Books | 6 | go undercover as a patient with Viktor prompting in V's ear | Kabuki back-alley clinic | undercover talk, `gear` check, brawl risk |
| V5 | Patient Confidentiality | 8 | hostage rescue where gunfire near the ward kills the patient | Watson waterfront warehouse | hostage, talk or stealth or combat, escort, ride |
| V6 | Corner | 10 | be his corner man for three rounds, then hold the lamp | Watson hall of the Grand Prix | `bout` as corner, sit, talk, keepsake |
| RW1 | The Case of the Real Celery | 3 | canvass three leads for real vegetables | Heywood to the Badlands edge | canvass by `archetype-talk`, ride, small fight |
| RW2 | Cold Coffee | 4 | 90-minute stakeout where doing nothing is the test, then a short follow | Northside tower lobby | timed presence, follow on foot |
| RW3 | Open Window | 5 | search a flat while River holds the super on the street | Westbrook tower | stealth indoors, `post`, `remote` |
| RW4 | Polite Distance | 6 | lose a tail without breaking a law, then wait for the driver | Watson, Westbrook, Heywood | reverse chase (`tail`), ride, ambush by talk |
| RW5 | Until the Sun Comes Up | 8 | hold a farmhouse until dawn for a witness | disused Badlands farm | `hold-until` waves, `post`, escort, sit |
| RW6 | Off the Clock | 10 | keep River off a case for a day, then a meal at the water tower and a recipe card | the road to Joss's, the water tower | ride with temptations, camp meal, handover |
| T1 | Honest Food | 3 | choose a counter and judge three dishes without insulting the cook | Japantown food street | `seat`, `npc-react`, tasting talk |
| T2 | Look Twice | 4 | watch a staged square, turn away, answer four questions | Japantown square | look check, quiz by talk |
| T3 | Pincers | 5 | learn the lanes, then cut a thief off on foot | Japantown back lanes | walk, foot chase, sit and talk |
| T4 | Word of Honour | 6 | escort a frightened clerk through three districts to a boat | Japantown to the Arasaka Waterfront pier | escort on foot, stealth, eddies |
| T5 | Choose Your Ground | 8 | prepare a position, hold three waves, refuse or take a bribe | his hideout | defend in waves, negotiation, sit |
| T6 | A Name for the Plaque | 10 | witness his plaques at a shrine and give a name | Japantown shrine | ritual walk, stations, sit, handover |
| S1 | Ordinary Thursday | 2 | walk a Brooklyn-like street with her voice, pick a song, sit on a stoop | an old neighbourhood (Heywood, verify) | remote walk, `radio` check, sit |
| S2 | The Locker | 3 | sneak to a rooftop locker with old patrol intel | rooftop near the Black Sapphire, Dogtown | stealth with a spotter, retrieve |
| S3 | Return to Sender | 4 | carry a shard to Alex and report her answer exactly | the Moth, Dogtown | item handover, talk, choice tags |
| S4 | Left at the Burned Billboard | 5 | find a place from a damaged memory with no map pin | Dogtown to a Santo Domingo overlook | navigation by memory, drive, look |
| S5 | The Mirror | 7 | rescue a young runner through a silent shielded container | Longshore Stacks, Dogtown | stealth, `dead-zone`, hostage, escort, ride |
| S6 | Same Sky | 9 | go high on a clear night, answer one question | a rooftop in the city | look, choice, long talk |

Collisions found across characters and rewritten in this pass:

* **Judy J6 against Songbird S4**: both had "find a place from a memory with hints". J6 now recreates her grandfather's frame on the hill with V
  standing where he stood (a photo moment with a dwell), and S4 keeps the memory navigation.
* **River RW6 against Panam P6**: both were a drive out to a Badlands overlook with a radio check and a keepsake. RW6 now ends at his own water
  tower with a meal and loses its radio check (the third temptation is an old colleague at a roadside stop).
* **Panam's hangout against River's**: a bottle range against Tin Can Alley. Panam's became Billboard Beers.
* **Judy's ramen hangout against Takemura's T1**: both judged dishes aloud. Judy's became Spot the Cut, at a BD parlour.
* Ids: River's and Rogue's hangouts were both `RH`, Songbird's hangouts reused Johnny's `SH`. River's are now `RWH` (and his reach-outs `RWR`),
  Songbird's `SBH`.
* Inside each half, the helpers had already rewritten eight collisions (Jackie's chase from bikes to a foot chase over stalls, Rogue's drive
  check from radio to weather, three bottle endings cut to one, Kerry's stall moved to Japantown, River's stakeout away from Judy's door duty,
  Viktor's undercover quest from stealth to talk, Takemura's last quest from cooking to the shrine, Takemura's thief from food to his notebook).

Close pairs kept on purpose, because the loop or the twist differs:

| Pair | Why it stays |
|---|---|
| JW2 (foot chase over Kabuki Market's stalls) and T3 (foot cut-off in Japantown's lanes) | Jackie's is a chase with a buy-back, Takemura's is won by the lanes V learned first and never by speed |
| P4 (plant a device at a relay, Panam counting the patrol) and S2 (reach a locker, Songbird's intel is stale) | P4 is about staying unseen to the end, S2 is V describing the roof so she can re-plan, her eyes are V's |
| R3 (extract a defector on foot) and T4 (escort a frightened clerk to a boat) | R3's route comes from V's answers to her four questions, T4's clerk can bolt and must be talked back |
| J4 (defend Lizzie's in waves), T5 (prepared position, three waves, a bribe), RW5 (hold a farm until dawn) | three defences: one by the door with Mox allies, one prepared and parleyed, one against the clock with a witness |
| J5, K4, V5, S5 (four hostage rescues) | a scav XBD den, fans holding a guitar tech with Kerry as bait at the door, a ward where gunfire kills the patient, a silent container where her voice cannot reach |
| SH5 (sit by a stranger at a memorial over Corpo Plaza) and T6 (his plaques at a Japantown shrine) | Johnny's is about the victims he never counted, Takemura's is a ritual of the names he serves |
| JW6 (a Little China roof the night before the Heist) and S6 (V's own high place under the sky) | Jackie's is four stages with Misty, a call and a bottle, Songbird's is V's chosen place, a weather wait and one question |
| V1 and V6 (Viktor's two bouts) | a spectator calling punches, then V as his corner man |

## 21. The primitives, sorted by how many quests use them

Counted over the sixty quests' texts (a quest counts once). Every primitive below has one owner at run time: the quest's reaper, which removes
every spawn, pin, timer, watch and tag it made on success, failure, death, a load and the setting going off, and a sweep at session start that
removes anything tagged that a crash left behind. The quests also all use `line` and `gap` (section 14), and the 50 hangouts add their
own uses (shown after the plus). Existing pieces are marked "exists", with what they still lack.

| Primitive | Quests | Status | Technical sketch |
|---|---|---|---|
| `line` | 60 + 50 | new | 14.2: pack text plus rendered audio and face rows, preloaded at the stage start, played under the speech lease, no model call |
| `gap` | 60 + 50 | new | 14.4: a stage state with a volatile note, an idle, resume cues (tag, timer, world event), stored words |
| `place` | 60 + 50 | new | shipped points with a radius and words (`places.json`, captured in game with a developer key that writes V's position and the district), each point snapped to the ground by one downward ray when used. "Arrived" and "left" come from the district change event first (`PreventionSystem.OnDistrictAreaEntered`, already observed), then a position read at 1 Hz only while a stage waits on that place and V is in its district, 0.2 Hz farther away. Inner spots, dwell times, hint ladders and no-pin chains are data on it. A meeting point's map pin is the separate `pin` primitive (next rows) |
| `image` | 50 | new | the game cannot load a PNG at run time, so a pack's PNGs are cooked at build time into a texture and an atlas inside the pack's own `.archive` (the pack builder runs the WolvenKit command line the repo already keeps in `vendor/`), and the Phone Chat message row shows an atlas part by name with its caption as the message text. Flags `own-shot` and `memory-frame` for Johnny's thread, variants by relationship. Live test owed: an atlas from a pack archive reaching the chat bubble |
| `history` | 45 | new | an ending's lasting line, kept in the pack state (follows the save), at most 8 per character, the 3 newest and the top quest's sent as one world-tier line ("what you and V have been through"), so the prefix caches only change at an ending |
| `meet` | 40 + 50 | exists | Immersive invitations, plus a new `place:<id>` destination (today: here, home, waypoint) and a "placed out of sight at a fixed spot" arrival for hangouts like Billboard Beers |
| `pin` | 37 + 50 | new | a map pin on a meeting point (the places listed in the quests' Pins lines, and every hangout's place). `MappinSystem:RegisterMappin` with the point from `places.json`, snapped to the ground like `place`, one pin per stage at most, registered when the invitation is sent or the stage begins (which game pin icon fits is to verify). The game does not keep a mod's pins across a load, so the pin is registered again at every session start and after every save load, from the saved stage, and removed on arrival, on every exit of the stage and by the reaper. Hidden routes, find-it-alone places and the Reed branch get none. Live test owed: register one from the mod, see it, load a save and see it again |
| `cast` | 35 | new | a nameless extra or a copy of another character spawned for a stage through the party queue's spawn (`DynamicEntitySystem`, tagged, non-persistent, the ambush squad's cleanup), talkable as an ordinary NPC by its archetype, with a hidden stage note (its own know and wants), timed arrivals and a recognition event (K2). Friendly fighters (J4's Mox) are the faction's records spawned friendly |
| `together` | 31 + many | new | V and the copy within N m for M game minutes, optionally seated or in the car, sampled every 10 s while the stage waits (one distance read), paused while apart, also the bond model's phase 2 "time together" |
| `seat` | 29 | exists | companion seating and the housemates' seat search, plus a "seated together" event and ground or ledge seats (new workspots, 19.1) |
| `npc-react` | 23 | exists | ordinary NPC reactions (leave, police, attack, cower, brawl, commands) on spawned extras and squad bosses, which count as ordinary NPCs. Needs the reaction outcome reported to the runner as an event |
| `squad` | 21 | new on an existing spawner | the Revenge ambush squad builder at a pack place: records checked against TweakDB, created through `DynamicEntitySystem` specs with a per-quest tag and the shared tag (swept once at session start), placed on ground-snapped points, each member used only after it is attached (retried briefly). Hostile takes all of: attitude both ways, a live combat AI role, an aggressive reaction preset and the trigger into combat, with a shared threat for a garrison that must react as one. Relaxed squads get only their faction's normal attitude. Waves with timers or "when the last is down", patrol points, a timed alert, vehicles for a wave (unverified), spawned when V is within 150 m and out of sight, success when all are down, fail when V is 200 m away for 60 s |
| `eddies` | 21 | exists | asks, repays, gifts with the pack as the story, plus a new small flow "V pays an ordinary NPC" (toll, haggle, tab) |
| `ride` | 18 | new | the copy mounted as V's passenger (the vehicles code already knows), then arrival at a place, with ordered checkpoints, a hidden route (no map pin, directions as lines), a game-time limit and a heat rule |
| `remote` | 18 | new | a copy's line heard at full level in V's ear (the `holocall` lease flag) from a post or a car, or a bodiless speaker through `johnny-voice` (Songbird), with a `dead-zone` place that silences it |
| `post` | 17 | new | the copy walks to a fixed spot (the housemates' walk-to-spot) and holds it with an idle, a stance or a seat in a car, released by the stage, fights from it when the stage says so (companion tactics with a hold-position flag) |
| `party` | 16 | exists | the copy follows, rides as passenger |
| `check` | 15 | new | one read at a checkpoint: V's look (`gear`), the radio song, the hour, the weather (a weather system read, verify), the heat, an item V holds |
| `call-in` | 15 | new | 14.3: the mod starts an incoming holocall (unverified), a Phone Chat text plus V calling as the fallback |
| `text` | 14 | exists | Phone Chat fixed lines (appointment events) |
| `memory-share` | 13 | new | an ending note copied into related characters' memory (their own copies get it as a synthetic exchange, game-placed ones as talk only), named in the ending |
| `unseen` | 12 | new | the game has no "spotted" event to hook, so "spotted" is any squad member's high-level state turning to combat (a blackboard read per member every 1 to 2 s while the stage waits) or V's own combat state (the busy test already reads it). The squad spawns with its faction's normal, non-hostile attitude so the game's own perception does the detecting |
| `workspot` | 12 | new | a chosen vanilla workspot on a copy at a place, the same device the gestures and seats use (19.1) |
| `items` (`giveItem`, `takeItem`) | 9 + gifts | exists, unverified | `TransactionSystem` calls with the allowlist, a quantity check first |
| `chauffeur` | 6 | exists | she drives V to the map destination, plus a fixed route of points for P3 and R4 |
| `her-car` | 6 | exists | her car from the catalogue |
| `gestures` | 6 + all lines | exists | conversation gestures by category |
| `archetype-talk` | 6 | exists | talking to an ordinary NPC of a kind in a district, reported by kind and district |
| `heat` | 6 | exists | the wanted level read. Raising it can only be done from redscript (no quest here raises it) |
| `hostage` | 5 | new | no restrained pose is known in the game's library. Two forms: a captive kept down on the floor (spawned friendly, configured, then her health pool drained a moment later so she lies wounded, with god mode against death) whom V helps up, or a kneel or sit workspot held still with a per-entity time dilation and invulnerability (live test owed). The squad's "go for the hostage" rule is the pack's own timer, which lifts her protection. Freed, she becomes a temporary follower (`escortee`). A body held still can never be mounted, so before a car she is replaced by a fresh copy with the same appearance |
| `runner` | 5 | new | a spawned car, bike or pedestrian on a fixed route, driven by the invitation car's drive-to-point command in legs (`AIVehicleDriveToPointAutonomousCommand`, already used, with traffic cleared on the path), arrival judged by the car's distance to the leg's end, never by the command's own flag, and a mounted driver never teleported. Caught within N m or stopped, lost at the route's end. Variants: on foot (JW2, T3, VH3), and `tail`, the reverse, a car that follows V at a gap (the game's follow command for vehicles, re-sent every few seconds, SH4, RW4) |
| `fight` | 5 | exists | companion tactics against a target, plus "from a post" |
| `radio` | 4 | exists | the song and station events |
| `johnny-voice` | 4 + Johnny's 6 | exists | a bodiless voice (Johnny, Songbird's ear) |
| `bout` | 3 | new | a fists-only exchange between two extras, or a copy and an extra, in timed rounds, stopped at a health floor (the damage system's own "defeated, not killed" on unarmed hits, verify), V never in it. If it cannot be made safe, it is played as a talk-and-bet scene |
| `escortee` | 3 | new | a calm follower who can bolt on a tag and be talked back, the same follower as a freed hostage, with a health bonus and a leash (moved to V's side at 25 m only while not mounted and out of sight) |
| `gate-plus` | 19 (by gate) | new | gate fields `facts` (Takemura alive, Pisces' outcome), `before` and `window` (Jackie's Act 1), a new arc entry (Songbird) and the `unfinished` ending class. The `facts` reads are the only places a primitive needs a game quest fact, and they are reads: no primitive writes one |
| `district` | 2 | exists | the district events |
| `gear` | 2 | exists | V's visible clothing and drawn weapon |
| `tail` | 2 | new | see `runner` |
| `convoy` | 1 | new, hard | three spawned cars driving in a column to a place: the invitation car's sequencer per car with a lead and followers re-targeted every 2 s, a reroute choice, a car-lost event. Autonomous traffic AI in a column is the riskiest piece in the document: P5 falls back to the Mackinaw alone with the two cars "behind, off screen" if it fails live |
| `race` | 1 + PH5, K3 | new | her car drives to a finish place with the drive command while V drives, first arrival wins, with a heat rule |
| `outfit` | 1 | exists | another appearance of hers |
| `hold-until` | 1 | new | `squad` waves won at a game hour, not by kills |
| `dead-zone` | 1 | new | a `place` that silences `remote` |
| `apart` | 1 | new | a privacy ring: V between two radii for N minutes |
| `battle-remarks` | 1 | exists | a companion's remark after a fight event |
| `call-script` | 19 calls | new | 14.3 |
| `reach-out` | 86 triggers | new | section 15: the trigger table, the caps, delivery by text, call or Johnny's voice |
| `hangout` | 50 | new | section 16: a one-stage pack kind with repeat variations and its own cap |
| `gift` | 10 tables | new | section 17: the inventory read on a giving turn, like rules, rarity by level |
| `music`, `sfx` | about 15 stages | new | section 19: pack files through the renderer, radio station switching, game events unverified |
| `garage` | 0 quests (Kerry's gift) | allowed by the owner, 29 Oct | the game's vehicle unlock call: adds Guinevere to V's garage for good, a save change |

## 22. Build order

Each step is usable on its own and builds on the last. Phase numbers continue the system doc's (phase 2 is the pack runner, built now on this
branch by the other agent).

1. **Format 2 and the validator** (`schemas/`, `bridge/bond-packs.mjs`): lines, gaps, calls, places, images, gameplay entries, JSON Pointer
   errors. Convert the three example packs. Tests only.
2. **`line` and `gap`** on the phase 2 runner: preload, lease, face rows, the one-voice rules, the gap note and resume cues. First live test:
   the light quests that are only talk and meetings (P1, J1, K1, SH2, RW1 first half), with lines voiced live until the render exists.
3. **`place`, `pin`, `together`, `seat` events, `image`**: the place capture key, the district-first watch, the map pin (live test first: register one from the mod and see it survive a load), presence, the Phone Chat image row. Now every
   walk, hangout and sit works. Ship the first hangouts here (they are the cheapest content per primitive).
4. **`call-script`, `call-in`, `text` openers, reach-outs**: scripted calls with V calling as the fallback, the reach-out scheduler and caps.
5. **`ride`, `post`, `remote`, `check`, the pay-an-NPC flow**: drives, overwatch, voices in V's ear. Unlocks P2, P3, R4, V2, K1, S1 and more.
6. **`cast`, the `npc-react` events, `gift`**: extras with notes, door duty, interviews, haggles, the gift tables after the in-game id check, and Kerry's Guinevere through `garage`.
7. **`squad` at a place, `unseen`, `hostage`, `escortee`**: the action quests. Measure FPS with a full wave in the stage clock before shipping.
8. **`runner`, `tail`, `race`, `bout`, `hold-until`, `dead-zone`, `apart`**: the special loops, each behind its quest.
9. **`convoy`** last, and P5's fallback first.
10. **Render**: once the voice engine is chosen, render every line in English (section 25), then ship audio per character as the quests are finished.
11. **API 1.2** for community packs: the manifest field, the safety caps, the docs, the example pack.

A character is shippable when all six quests and its hangouts work: the order of characters follows what their quests need. Judy and Panam's
light quests come first (steps 2 to 5), Songbird and Johnny early (mostly `remote`, `place` and talk), Jackie with the `gate-plus` window,
Takemura and River after `squad` and `runner`.

## 23. Failure, retries and V walking away

* **Soft failure is story.** Most "failures" are branches with their own ending (the courier reached the buyers, a car was lost, the hostage
  died): the quest ends, the character remembers it, the bond moves less or a little down. These cannot be retried, on purpose: they happened.
* **V dies**: the game loads a save. The pack state is stamped with the game clock, so the load rolls the quest back to where that save was (the
  system doc's rollback guard), the squads and extras are removed by their tag at the world's end, and the stage plays again from its start.
  This is the retry, and it is the game's own.
* **A combat stage V walked away from** (200 m for 60 s while a squad stands): the stage's `ran` or `fled` branch. Within the stage's timer V can
  say "let's go back" (a choice tag) once, and the squad is spawned again. After that it is the ending.
* **Abandoning**: V says "I'm out" or "forget it" (a tag the stage offers), or the stage's timer runs out (every stage that waits on V has one):
  the quest's `abandoned` ending, a small hurt (-5 to -15 by level), one line about it now and one later. An abandoned quest can be offered again
  once, after a cooldown of 7 game days, if its pack marks `retry: true` (most light quests do, the deeply personal ones do not: she does not ask
  twice for that).
* **Stood up** at a meeting: the invitation's own stood-up, as in the system doc.
* **The copy is lost** (downed, dismissed, too far): the stage pauses, she texts where she is, and a `meet` brings her back. A downed copy in a
  fight gets back up as the mod's companions do. If the quest needs her and she cannot come, the stage waits for its timer.
* **Pausing**: a story quest of hers starting, a scene, the main story's end, the setting off, or the content pack switched off pause every timer
  and spawn nothing. Jackie's open quest at The Heist ends with `unfinished`.
* **One at a time**: one quest per character, two quests at once in all, and no hangout of a character with an open quest.

## 24. How quests and free talk remember each other

* **During a quest**: every turn to her carries the stage's `know`, `wants` and gap note, so V can ask anything and she answers in the quest's
  reality. Played lines are in her memory as her own words.
* **At an ending**: three layers. A 3-game-day note (the system doc's ending memory), a synthetic exchange in the local store for the text
  providers (as Immersive invitations does for a missed meeting), and the `history` line that stays for good (section 21).
* **Across quests**: later quests read earlier choices (Judy J5 reads J3's ending, Panam P6 quotes V's critique from P5, Jackie's quests build to
  JW6), and a gap's stored words can be quoted later.
* **Across characters**: `memory-share` endings give related characters a line (Mitch hears about the toll, Susie Q about the door, Misty and
  Mama Welles about Jackie's last night, talk only for the game's own).
* **Across saves**: the shared bond follows the memory, packs and their history follow the save (the system doc's rule). A character never
  remembers a quest the loaded save has not had: the `history` line belongs to the pack state. Quest state lives in the mod's own save-linked storage (the pack state, stamped with the game clock) and writes no quest fact. Game quest facts are only read, and only by `gate-plus` for two things (Takemura alive, Pisces' outcome).
* **Forget**: Forget clears the memory and the shared bond as today. The pack history of a save is cleared with it for that character, so she
  does not carry a quest she cannot remember.

## 25. Rendering estimate (for planning, nothing is rendered now)

Counted from this document: 1,189 scripted quest lines (about 11,100 words), plus about 110 reach-out openings, about 180 hangout lines
(invitations, gap questions, activity barks) and 80 gift lines: **about 1,560 lines and 14,000 words**.

| | Value |
|---|---|
| Speech at about 2.6 words a second, plus 0.3 s of padding a line | about 5,860 s, **1.6 hours** of audio |
| Raw PCM, 16-bit mono, OmniVoice (24 kHz, 48 KB a second) | about **280 MB** |
| FLAC (about 55 % of PCM) | about 155 MB |
| Ogg Opus mono at 48 kbps (Opus resamples to 48 kHz) | about **35 MB** |
| Face rows (precomputed, compressed) | about 10 to 20 MB |

Recommended shipping form: Ogg Opus at 48 kbps (the renderer is a browser page and decodes Opus natively), one file per line, so a line can be
re-rendered alone, and per character packs of about 4 MB. The audio is English only for now (owner decision of 29 Oct). Later languages, made through the creator toolkit's translate and voice tools, would multiply the audio, not the text.

## 26. Owner decisions (2026-10-29)

The owner answered the open questions on 29 Oct 2026. Each question is listed with its decision and where this document applies it. The numbers are the old question numbers. Two questions were not
answered and stay open at the end.

1. **Songbird on the other branches.** Nothing at all on the Reed branch: no quest, no reach-out, no hangout, no gift. Applied in sections 0 and 13 (the freed-branch marker gates all four systems) and section 15.
3. **Jackie's pacing.** The gates are lowered. His six quests unlock at levels 2, 2, 3, 4, 5 and 6 instead of 4, 4, 5, 6, 7 and 8, with the quests in the same order. Applied in sections 0, 8 (every gate), 14.1 and 20.
4. **The voice of pre-rendered lines against a player's live voice.** Scripted lines are always played as the prepared audio, whatever live voice the player uses (Voxtral, Convai, Pocket). The mismatch is accepted. Applied in 14.2, 14.6 and 14.7.
5. **Languages.** English first. The scripted lines are written and voiced in English only for now. Other languages come later through the creator toolkit's translate and voice tools. Applied in 14.7, 18.2, 22 and 25.
6. **`garage`.** Kerry's Guinevere is allowed as his legendary gift. It is added to V's garage for good and changes the save. Applied in sections 2, 17.2, 17.3, 21 and 22.
7. **Gift ids.** They get an in-game check before any pack uses them, which is a task for the build. Applied in 17.3 and 22.
8. **Reach-outs.** Off by default (30 Oct), with a setting (Characters text first) to turn them on, and they need Story packs. Applied in section 15.
9. **Hostages and waves.** Kept as designed: five hostage rescues and three defences. No change.
10. **Invented details.** Kept: Kerry's first guitar (K6) and the SAMURAI flyer (K1), the names of the convoy's two Aldecaldo drivers (P5), the plant Songbird named and her fourteen-track playlist (S2, S6).
11. **Nancy Hartley.** Kerry's old bandmate, now a reporter, following the mod's character profile. Applied in the Kerry notes and appendix A.
12. **The document's size.** The scripted lines, the holocall scripts and the per-quest line lists moved to [BOND_QUEST_LINES.md](BOND_QUEST_LINES.md), organised by character and then by quest. Each quest here ends with a pointer to its lines.
14. **Where quest state lives.** The system doc's rule stays: bond state follows the save through the mod's own save-linked storage (the pack state, stamped with the game clock). Game quest facts are used only where a
    primitive truly needs one, and that is only `gate-plus` reading two facts (Takemura alive, Pisces' outcome). Nothing writes a quest fact. Applied in sections 21 and 24.
15. **Map pins.** Yes. Quests place map pins at their meeting points ("meet Panam here"), registered with `MappinSystem:RegisterMappin` and registered again after every save load. `pin` is a primitive, and the
    quests' meeting points carry a Pins line. Applied in sections 2, 3, 16, 18.2, 21 and 22.

**Answered later on 29 Oct:**

2. **Songbird's fate**: left a mystery. She calls and texts from somewhere unnamed, no line says where she ended up, and nobody names a place.
13. **Community packs**: packs may target characters a player made in the character editor, by the character's id, as well as roster characters.
14. **A shipped line with no audio file**: shown as a subtitle and an error is logged, never spoken by the live voice.

## Appendix A. Lore and engine points to verify

The helpers' lists, by quest group. Each item is also marked "(verify)" where it appears above.

### From the Johnny, Jackie, Rogue and Kerry quests

* The journal titles of `q001_01_victor` and `q001_02_dex` (written here as Victor, Victor and The Gig), and the exact titles of `q108_johnny` and `sq011_concert`, which the quests describe
  rather than name.
* **Jackie's pacing**: how many game days pass between the end of The Information and The Heist. The owner lowered the gates on 29 Oct (2, 2, 3, 4, 5, 6) so that more players reach all six, and the real number of days is still worth reading from a save. If few days pass, some players will still meet only the first quests.
* Whether the game keeps The Heist's briefing quest active but untracked in a way the `gate-plus` window can read, and whether a "no scene is running" test exists for it.
* Jackie's bike model (Arch Nazaré) and whether a copy can sit on it, a pillion, or lean on it as a workspot.
* A weights `workspot` and an unarmed fight between copies (JW4). The gym in V's megabuilding (H10, Kabuki), a pit warehouse in Northside, a rooftop in Little China with a view of the bay.
* A rooftop walkway route above Kabuki Market (JW2) and the Maelstrom yard that is not the one from The Pickup (JW3).
* Misty and Viktor as talk-only game-placed characters in Act 1, and Claire as the Afterlife's bartender (JW5).
* **Nancy**: the brief calls her Kerry's manager, but the profile says she is a former SAMURAI keyboardist and now N54's Bes Isis. Decided 29 Oct: the quests follow the mod's character profile, so she is Kerry's old bandmate and now a reporter, and she hears about K4 as an old friend.
* The existence of a Caliente diner or any named coffee place (K1), a Japantown night food street (K2), Atlantis Stadium's lot in Heywood as a race finish (K3), a closed theatre in
  Westbrook (K4), whether Rayfield Aerondight "Guinevere" is a catalogue car for him (K3), whether he has a plain disguise appearance (K2).
* **Tokyo's offset**: Tokyo is already a day ahead of California, so K5 says "tomorrow in Tokyo" and the pack avoids a number of hours.
* **Kerry's first guitar (K6)** and the SAMURAI-flyer detail (K1) are invented backstory. The profile only says early money went into guitars and strings. The owner kept them on 29 Oct.
* A SAMURAI-logo garment in the game (SH4), any station that carries a SAMURAI song (SH2), whether Totentanz can be entered while closed (SH6), a memorial lookout over Corpo Plaza (SH5),
  the exact depot at Jackson Plains (SH3), the Japantown shop (SH4).
* Rogue: whether `sq031_cinema` (Blistering Love) can be missed (if so the full shared gate would lock R3 to R6 for those saves and the owner should choose "finished or not available"), the
  Quadra Type-66 in the catalogue, the private booth upstairs at the Afterlife, a Kabuki capsule hotel, an all-night laundromat in Little China, a waterfront lot near the Kabuki yard.
* Rogue's "four questions" are the profile's reach, backup, extraction and defences. The "fifth question" and the bar tab are invented, nameless and harmless.
* The text of the Johnny memory frames: nothing states a death toll or a day for 2023. Johnny's guilt is shown as his own testimony.

### From the Viktor, River, Takemura and Songbird quests

* Viktor: the exact Night City Devils gym and the Watson hall of the Boxing Grand Prix (do they exist as places?), whether a heavy bag or gym `workspot` exists, the
  "second place" medal as a physical object, that Misty's copy can be spawned for V3, and whether tarot card names used in V3 (the Hermit, the Wheel of Fortune,
  Strength) clash with the cards of `mq033_tarot`.
* River: ex-NCPD status in the current save, whether the missing boy of `sq021_sick_dreams` is Randy (the profile text implies it), Joss's home as a Red Peaks trailer park
  (profile) against a family farm in the Badlands (the lead's frame), the Biotechnica Flats roadside spot in RW1, the real overlook in RW6, the water tower's
  location in `sq029_sobchak_romance`, and that no kid's age or any other family detail is invented beyond the three names.
* Takemura: the real name of the "alive" fact (placeholder `takemura-alive`) and which quest can kill him, the location and layout of his hideout from
  `q112_04_hideout`, whether any Japantown shrine and its water basin exist as places, the name of the Japantown food market, whether a world cat can be spawned
  (T6), that his old Arasaka bounty still plausibly draws freelancers in T5 after the Hanako events (it depends on the ending), and that no quest uses Hanako's body.
* Songbird: the exact freed-branch marker (`q306_somi_epilogue` and `q306_postcontent` finished, `q306_reed_epilogue` not begun), the neighbourhood that reminded her of
  Brooklyn and the rooftop V shared with her in Phantom Liberty, whether V still carries the Relic on this branch (so whether "her voice in V's ear" can
  be worded as a Relic link), whether she is alive and where she is (every line stays at "far away", the S6 window image has a plain-sea variant), that the Moth's
  Alex is available and willing after `q306_somi_epilogue`, the Longshore Stacks container maze as a stealth setting, the Black Sapphire rooftop as the S2 place,
  and the invented music player with fourteen tracks (S2, S6) and a plant she named (S6), all kept by the owner on 29 Oct.

### From the scripted lines, reach-outs and hangouts (Johnny, Jackie, Rogue, Kerry)

* Johnny: the hangout places in Santo Domingo, City Center (Corpo Plaza shopping levels) and Heywood (a Wellsprings bar, a Vista del Rey cart), and whether the game has a SAMURAI-logo garment. The iconic item for his legendary gift (his aviators) is a catalogue question.
* Jackie: the Act 1 corner club and the back-alley garage in Kabuki, the Arasaka Waterfront pier, the Northside back roads and rooftop, and whether a dance, repair or fishing pose exists as a workspot for a copy. His iconic gift (the key to his bike) needs a decision, and no Jackie text says anything about a future.
* Rogue: the Charter Hill terrace and gallery, the Downtown restaurant and high-rise bar. Her "number that opens any door in the Afterlife" is a story word, not an item.
* Kerry: the North Oak instrument shop and neighbour garden, a Pacifica beach and an old Pacifica pier that are safe and reachable, and whether the Pacifica coast is accessible outside the Combat Zone. "Guinevere's keys" as a gift is allowed by the owner (29 Oct) and needs `garage`.
* Where the lead's brief says Nancy is Kerry's manager, the profile says she is a former bandmate and now a reporter. The scripts follow the profile (decided 29 Oct): Kerry's old bandmate, now a reporter, who hears about K4 through `memory-share`.
* Texts and holocalls start only from the mod's own channels, never from a game-placed character.

### From the scripted lines, reach-outs and hangouts (Viktor, River, Takemura, Songbird)

* All sound and workspot ids named in `music:` and `sfx:` lines and in animation columns (game library ids for the bell, a monitor beep, harbour wind, the temple bell, device beeps).
* The hangout places: Megabuilding H10's courtyard and the Little China noodle alley and canal-bridge tea stall for Viktor, the Glen taco lot and rooftop, the Red Peaks gulch and the other Badlands spots for River, the Japantown rooftop tea garden and karaoke bar, the Vista del Rey terrace, the Wellsprings tailor and promenade for Takemura, Heavy Hearts' card table, the Dogtown Wall market lot, the Grand Imperial Mall, the stadium plaza and the water tower for Songbird.
* Event names the reach-outs and barks assume (an item consumed event for TR3, a low-health fight end for VR2 and RR4, a radio song and station event for SR5, a rain-start event for SR8, a cyberware change event for VR5, the exact journal path for VR7), and that the scanner burst in RW6 can be read from a `radio` event.
* Whether a boxing `bout` stop count and a handicap can be tuned, and that Jackie's alive or gone state can be read from the turn for V6.
* Songbird: each quest's channel assumes holocalls and Phone Chat work after the freed-branch marker, and that her voice in V's ear can be worded without claiming the Relic link (see Part B).
