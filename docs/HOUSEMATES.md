# Housemates

Status: **built** on branch `feat/housemates` (2026-10-25), phases 0 to 2 of the plan below, on top of `feat/immersive-invitations` (visiting copies,
`joinVisitor`). Source and fake-world tests pass; **nothing has been seen in the game yet**. The list in "What only a live run can settle" and the
steps in "Live test, step by step" are what to run first. The design below was reviewed by the owner on 2026-10-25; "Owner's decisions" lists the
answers and where they changed it. Every statement about a game API says whether the mod already uses it (and where) or is a guess a live run settles.
The archive research behind the apartment tables was done with the WolvenKit CLI, read only, on the 2.31 install (WolvenKit 9.0.1 cannot parse
the 2.5 streaming sectors, see "Uncertain"). Nothing in any game folder was touched.

A housemate is a character V has told "you can stay at my place". She lives in the apartment V named, sits on the furniture, stands at the
window, sleeps, wears casual clothes, talks with the other housemates now and then, and goes out with V when asked. There is no cap on how
many live there.

## Requirements (owner, 2026-10-25) and where each is answered

| # | Requirement | Section |
| --- | --- | --- |
| 1 | "You can stay at my place" moves her in. The apartment V names. No name: she asks which, V's answer picks it. Only apartments V has. Different housemates, different apartments. | Moving in, Apartments |
| 2 | No cap on housemates | Many housemates (bodies are capped, housemates are not) |
| 3 | Tag along: she joins the party from home. Back home, "rest / leave / stay": she leaves the party and returns to her routine. | Party transitions |
| 4 | Group chat: release or recall applies to everyone addressed, even if not all reply | Group chat |
| 5 | Routines: mostly sitting, window, shower if possible, other believable spots; several housemates spread out (most sit, some stand) | Spots, Assignment, Routine |
| 6 | Real spots per apartment from the game's data, reusing COMPANION_SEATING | Apartments and spots, Tables |
| 7 | Sleep only in a bed that fits two, so V can still sleep; else couch / chair, or stay up | Sleeping |
| 8 | Home clothes, switched only when V is not looking, against the outfits branch API | Home clothes |
| 9 | Pair chat: one at a time, random pair, 7 to 8 lines, then a pause, V can join or call someone back, rate limited | Pair chat |
| 10 | Persistence per save, survives save/load and fast travel | Persistence |
| 11 | Out of the way during story scenes and quests, never break a quest | Quest and scene safety |
| 12 | FPS first: exists only while V is in or near the apartment, nothing per frame | Performance |

## What this builds on, and what it needs from the other branches

| Piece | Where | Use |
| --- | --- | --- |
| Party copies, spawn, delete, fast-travel capture | `mod/companions.lua` (`spawnCopy`, `attachFollower`, `deleteOwnedCopy`, `beginFastTravel`, `entries` with `state`) | A housemate body is a managed copy created by the same code |
| **Visiting copies** (immersive invitations, built on `feat/immersive-invitations`, phase 1 and 2) | `entry.visitor`, state `visiting` (no follower role, ignored by every loop that keys on `ready`), `invitation.appointment = {position, facing}` (spawn at a chosen spot), `visitors()`, `visitorSense/Walk/Hold/Mount`, `joinVisitor(serial)` (follower role on the same body, no respawn), `dismissVisitor`, `onVisitorLost`, fast travel deletes visitors first, `identity` and `conversationCandidates` accept `visiting` | A housemate body **is** a visiting copy with an owner tag and a home. Not a second mechanism |
| Leave offers and the walk-away departure | `mod/companion-adoption.lua` (`leaveOffer`, `queueLeave`, `departures`, `walkers`, `owns/decide`) | Release away from home; the group `all` form |
| Conversation actions are leased capabilities | `mod/gameplay-actions.lua`, `bridge/companion-actions.mjs` (`LEAVE_ACTION`, `leaveActions`, one lease per request, group first turn leases a leave offer, `#members < 3` cap in `leaveOffer`) | New offer kind for housemates; the cap is lifted for them |
| Seating of companions beside V | `mod/companion-seating.lua`, `docs/COMPANION_SEATING.md` (device entity carrying a vanilla NPC sit workspot, `PlayInDevice` with `PlayAtResourcePosition`, native fast exit, "step out", seat validation rays, walk-up pre-check) | The play/exit/step-out code and the four `convai_sit_*` components. Seats are searched around V there. Here they are fixed table entries |
| Gesture device and workspot plumbing | `mod/gesture-workspot.lua`, `assets/gestures/gestures.json` `seatWorkspots`, `scripts/Build-GestureAssets.mjs` (forces random lists to 127 clips and `loopInfinitely`) | New components for bed, chair sleep, counter lean, sink |
| Group chat | `mod/group-chat.lua` (`choose`: at most 3 speakers), `companions.conversationCandidates`, `bridge/companion-actions.mjs` | Residents are candidates; actions cover the whole audience |
| Automatic spoken lines | `mod/init.lua` automatic reactions (`reaction.kind` `head`, `loot`, `battle`, `addon`), `bridge/shared-key-guard.mjs` `RemarkAllowance` (Johnny's remarks take at most 10 percent of the shared key's day) | New kind `house` for pair chat lines, new allowance |
| Companion speak-up level | `settings.companionSpeakUp` (off, rare, medium, normal) in `mod/manager.lua`, `mod/johnny-remarks.lua` limiter shape (gap plus per hour) | Pair chat obeys the same level, no new setting |
| Place words and V's apartment records | `bridge/place-names.mjs` `HOME_PLACES`, `mod/init.lua` `currentDistrict()`, `mod/place-words.lua` (immersive branch) | Which apartment V is in |
| Outfits (branch `feat/outfits`, in progress in another worktree) | `mod/companion-outfits.lua`: `convaiOutfitApi.setHome(key, on)` (true home clothes, false never, nil follows V's whereabouts), `isHome`, `hasHomeOutfit(record)`, `companions.spawnOutfit(record, key)` (a new copy is created in the right clothes), `companions.outfitRows` (the curated copies the tick looks at), changes only when the game's frustum test says nobody sees her | Home clothes, nothing copied |
| Speak-up (branch `feat/dynamic-info-speak-up`, in progress) | not committed yet | Pair chat shares its limiter object when it lands. Interface in "Pair chat" |

Dependencies, in order: housemates needs the **visiting copy** work from `feat/immersive-invitations` (the first two rows' extra calls) and
the **home outfit API** from `feat/outfits`. If housemates is built first, phase 0 carries the minimal visiting-copy part (spawn at a
position, a state that is not in the party, `joinVisitor`) in the same shape so the two merge without conflict. Housemates does not need the
Immersive invitations setting to be On: it only uses the copy mechanics.

## Findings that change earlier assumptions

1. **`docs/COMPANION_SEATING.md` calls the sofa Judy sat on "V's apartment couch (H10)". It is in the Corpo Plaza apartment.** The measured seat root
   (-1602.30, 356.20, 48.62) lies inside the sectors of `loc_dlc6_apart_cct_dtn` (CorpoPlaza_Apartment), where the archive has a sofa mesh at
   (-1603.56, 357.14, 48.63) and the apartment's own `couch sit` workspot lands on exactly that point. H10 is at x -1395..-1375, y 1260..1280,
   z 123, 900 m north. The sit work and its tuning are not affected (the numbers are real), only the label. Fix the label when this lands.
2. **Save identity is not available in the shipped mod.** `capturePhoneBinding` in `mod/init.lua` always returns `status = 'unavailable'`
   (the native identity class stays quarantined, `docs/SAVE_IDENTITY_ALTERNATIVES.md`). The phone history uses `local-player-v1`, and the immersive
   branch's state (`saves[campaign:branch]`) falls back to `session:<world>`, which is **gone after a game restart**. A housemate that forgets where she
   lives at every restart is useless, so persistence here cannot be "a file keyed by the save line". See "Persistence": the game's own saved facts.
3. **The scripts cannot say which apartments V owns, but the quest data can.** Each of the four purchasable apartments sets one fact when bought
   (read from the cooked quest phases of the 2.5 install, names identical in 2.31): see "Apartments".
4. **No generic NPC shower animation exists.** The shower workspots in the archive are for the player rig or for one named character
   (`player__stand_wall_lean_front_shower__01`, `panam__stand_shower_lean_front__wash__01`). Generic NPC workspots do exist for sinks
   (`generic__stand_high_sink___wash_hands__01`, `low_sink`). "The shower if possible" is therefore a research item (phase 3), not part of the first build.
5. **Generic NPC bed workspots exist and are made for this**: `base\workspots\common\bed\generic__lie_double_bed__sleep__01` to `05`,
   `generic__lie_double_bed__lie_around__01/02`, `generic__lie_bed_lean_left/right__lie_around__01`; and `generic__sit_chair__sleep__01`,
   `generic__sit_barstool_bar_lean_front__sleep__01` for chairs and stools. No generic couch-sleep exists (only a Panam one), so a couch is "sit and doze
   awake", see "Sleeping".

## Moving in

### The words and the actions

All offers follow the existing pattern (`docs/WORLD_COMPANIONS.md`, `gameplay-actions.lua`): the game builds the offer, the bridge tells the
character what it may do, the character's answer decides, the game validates the answer against exactly what it offered. Coordinates, entity
ids and apartment ids never come from the model, only a pick among offered names.

**Offer kind `home` (new)**, built per request, leased with the others:

| Field | Meaning |
| --- | --- |
| `apartments` | The apartments V has, from the game's facts: id and name, at most 5. Empty offer when V has none (never happens, H10 is always V's) |
| `here` | The id of the apartment V stands in now, or nil |
| `homeOf` | If she already lives somewhere: that id (moving house replaces it) |
| `members` | For release and recall, the listed housemates and party members, see "Party transitions" |
| `unavailable` reason | `combat`, `scene`, `quest-reserved` (V is in an apartment whose quest scene is running), `not-eligible` |

Actions (Convai named actions, text providers through `bridge/text-actions.mjs` codes, both screened by `bridge/text-action-words.mjs` stems
like every other action, so an ordinary "stay for dinner" does not count):

| Action | Meaning | Validation |
| --- | --- | --- |
| `Stay At <apartment name>` (one per owned apartment) | She moves in there | The apartment is in the offer, the character is eligible, the lease is current |
| `Stay At V's Place` | Only offered when the choice is unambiguous: V owns one apartment, or V stands in one (then `here`) | Resolves to `here` or the only apartment |
| `Move Out` | She no longer lives at V's | She is a housemate |
| `Leave V's Party` / `Join V's Party` | Release and recall, see "Party transitions" | The member is in the offer |

**Which apartment.** V says "you can stay at my place":

1. V names one ("the one in Glen", "my place in Megabuilding"): the model picks `Stay At <that>`.
2. V names none and **V stands in an apartment**: `here`, no question.
3. V names none, is elsewhere, and owns exactly one: that one.
4. V names none, is elsewhere, and owns several: the character **asks which** in her own words and takes no action. The offer says so
   ("V owns: Megabuilding H10, Corpo Plaza. V did not say which. Ask which, do not request the move yet."). V's next message is a new request with a
   fresh lease; its offer carries `asked: true` for her (remembered for 3 turns or 10 minutes) so she treats "the Glen one" as the answer.
   The bridge builds the line, the game keeps the flag in the turn context (`homeAsk`), so it works on Convai and on the text routes.

Anything V says that is not clearly an apartment from the offer is not an action (the model must not invent "my other flat").

### Who can be asked

Exactly the rule that decides who may be invited today: a profile for which `companions.definition(key)` exists, `profile.invite ~= false`, not a game-placed
character. **A game-placed story character (the real Judy standing in Lizzie's) gets no actions** (`microphone.captureActions` already returns false; unchanged).
So the channels are:

| Channel | Who | Effect |
| --- | --- | --- |
| In person | A party member (our copy), a visitor (immersive), a resident | The offer rides the normal private/group turn |
| Phone Chat | Any phone contact who may be invited | Same offer on the phone turn (as the immersive meet offer). Holocall follows when the immersive branch wires calls |
| Group chat | The addressed party members and residents | One offer for the whole audience, see "Group chat" |

### What happens when she moves in

* **Writes the registry** (below): `homes[profileKey] = apartment`. One home per character. A second `Stay At` elsewhere moves house.
* **If she is a party member**: she leaves the party. If V stands in the apartment she was told to stay in, she is released into her routine there (the same path as "rest"). If V is elsewhere she leaves like a leaving companion (walks off, removed out of V's view, `companion-adoption`) and is virtual until V comes home. She does not teleport anywhere.
* **If she is only a phone contact**: nothing is spawned. She is a housemate, virtual, and shows up when V next comes to that apartment.
* **If she is a visitor** (immersive): the appointment ends quietly and she is released into the routine (or virtual if V is away).
* One notice (`ui.t`, 15 locales): "{name} moves into {apartment}." and the character has already said her answer. No ledger, no cost.
* **Memory**: the move is a turn the character answered, so Convai's provider memory sees it. For the text routes the same synthetic exchange the immersive branch uses ("[V said {name} could stay at {apartment}]") is recorded, and every channel's turn context carries a bounded note for her ("You live at V's place in {apartment}. You are home / V has taken you out.") so she talks like a housemate. Housemate presence also enters the "Also with V" list for turns in the apartment.

### Moving out

`Move Out` (model action: "you can't stay here any more", "time to find your own place") and, later, a **Housemates** block in the Characters page of the manager
with a Move out button per row (phase 2, optional, 15 locales). Both delete the registry entry and the body (walks out of the door out of view if V
sees her, else quiet).

## Apartments

### The list and how it is read

V's homes, with the district record the game reports inside each (the five the mod already uses, `bridge/place-names.mjs HOME_PLACES`) and the
quest fact the purchase sets (found in the cooked quest phases `dlc6_apart_<x>.questphase`, identical in the 2.5 and 2.31 archives):

| id | Name | District record | Owned when | Interior id |
| --- | --- | --- | --- | --- |
| `h10` | Megabuilding H10 | `LittleChina_VApartment` | always (V's from the prologue; no ownership fact exists) | `loc_megabuilding_a_env`, `mb_vs_apartment_env_arch` |
| `corpo` | Corpo Plaza | `CorpoPlaza_Apartment` | `dlc6_apart_cct_dtn_purchased` is 1 | `loc_dlc6_apart_cct_dtn` |
| `glen` | Heywood Glen | `Glen_Apartment` | `dlc6_apart_hey_gle_purchased` is 1 | `loc_dlc6_apart_hey_gle` |
| `japan` | Westbrook Japantown | `JapanTown_Apartment` | `dlc6_apart_wbr_jpn_purchased` is 1 | `loc_dlc6_apart_wbr_jpn` |
| `north` | Watson Northside | `Northside_Apartment` | `dlc6_apart_wat_nid_purchased` is 1 | `loc_dlc6_apart_wat_nid` |

* Read: `Game.GetQuestsSystem():GetFactStr(name) > 0`, four reads when an offer is built or the registry is checked (never per frame). The mod already
  reads quest facts (`mod/fact-identity.lua`, `mod/quest-context.lua`). The purchase phase only ever sets the fact to 1 and never resets it
  (checked: no setter writes 0), so a bought apartment stays owned.
* The same mod-visible names the player knows: the fast travel list has four "Apartment FT" entries (Corpo Plaza, Heywood Glen, Watson NID,
  Westbrook Japantown). A second, independent read (`FastTravelSystem:GetFastTravelPoints()`) is possible but unproven, so it is a probe, not the rule.
* Not apartments of V's: Judy's, Kerry's, Panam's and River's places in the same data (`dlc6_apart_judy_apartment`, `kerry_villa`, `panam_camp`,
  `river_trailer`) are the romance-visit scenes, not homes V owns. The Dogtown squat safehouse (`q302_squat_sh_unlocked`) and quest penthouses are out of scope (open question 9).
* **Risk**: the `mq055` quest file contains an 89-node phase that sets all four purchase facts to 1 together with about 80 prerequisite facts. It follows a test scene and looks like
  development scaffolding, but nobody has shown it never runs in a retail game. The first live check reads the four facts on a save that owns none.
* Which apartment V is in: `currentDistrict()` returns the specific record (the same read the outfits branch uses as `place()`). Event driven, see "Performance".

### Registry

`homes = { [profileKey] = apartmentId }` in memory, loaded at world ready from the save (next section) and written when it changes. A character not in `homes` is not a housemate.
All housemate logic starts from this table. With `next(homes) == nil` the module does nothing (a single check at world ready and at each district event).

## Persistence

**Decision for the owner (open question 1).** The only per-save store a CET mod can use today is the game's own saved fact table: facts are written
into every save by the game, a load of an older save brings back the older values, and a new game starts with none. That is exactly "keyed to the save",
including rollbacks, with no file, no save id and no timeline guard. Proposal:

* One fact per housemate: name `cyberpunkconvai_hm_<fnv1a32(profileKey) as 8 hex digits>`, value `1..5` (the apartment index in the table above). One schema fact
  `cyberpunkconvai_hm_v1 = 1`. Names in the mod's own prefix (the namespace `mod/fact-identity.lua` audited for collisions: `cyberpunkconvai_`).
* **Write**: `SetFactStr` on move in / move out / move house, nowhere else, never per frame.
* **Read**: once per world ready, for every known profile key (roster, archetype-free, custom characters from `mod/custom-characters.lua`): about 150 `GetFactStr` calls,
  well under a millisecond, after the loading screen. Facts cannot be enumerated, which is why the key list comes from the mod.
* A deleted custom character leaves a harmless stale fact.
* Not stored: party membership (as today, copies are not recreated after a load: **a housemate who was in the party when the game was saved is home when it loads**), spot, mood, time.
* Why not the file the immersive branch uses: it is keyed by a save line that the shipped mod cannot name (finding 2), so it would be session-only.

The project held fact **writes** off by default (`fact-identity.lua`: "all write and restore qualification gates default OFF") because the identity
protocol needs a multi-word atomic commit and a restore receipt. This feature needs neither (independent small integers), but it does turn on a write the
project has not run live. Live check 1 settles it (write, save, reload, read; load an older save, read the older value). If the owner declines facts, the fallback is
the immersive branch's file keyed `campaign:branch` or `session:<world>`, which is wrong after a restart, and the doc would say so in the README.

A mirror file `runtime/housemates.json` (player state, `bridge/game-state.mjs` copy list) holds nothing authoritative: last-written registry for the support report and for the manager page before a world is loaded. It is
never read back as truth.

## Apartments and spots

### How spots are found

Four layers, each one needed because the one before it is not enough:

1. **Archive data (done for this design, seed only).** The apartments' own scenes (`dlc6_apart_*_interactions.scene`) place the player workspots
   (sit, bed, shower, mirror) relative to a scene marker, and the sectors place the furniture meshes in world coordinates (2.31). The scene marker's own world
   transform is **not stored in any sector** (searched), so Corpo Plaza was anchored by the owner's measured seat and the others only partly. Meshes give
   positions ±0.3 m and no seat roots. See the tables: they are **seeds**.
2. **Furniture classification and seat roots, measured live (phase 0).** A development-only recorder (`mod/housemate-survey.lua`, Developer mode, driven by `scripts/Send-GestureProbe.ps1 "run housemate-record ..."`, never loaded for a player):
   * `record <kind> <name>`: V stands or sits on the spot, the recorder stores V's root (position and yaw), the floor under it, the navmesh point, the seat profile (`companion-seating.lua classifyGeometry`, the same rays) and for beds a lateral edge scan.
   * `scan <apartment>`: a raycast lattice (0.25 m) over the apartment bounds, spread over frames, producing horizontal surfaces at seat height (couch, chair, stool),
     the bed top and its width, and window walls (long vertical surfaces with open air behind at head height). Output to `runtime/housemate-survey.json`.
   * The owner's saves do not need to own every apartment: the recorder can teleport V to an apartment door on a throwaway save (CET `Teleport`) and the four
     purchase facts can be set on that save (`SetFactStr`) for the one-time survey. Open question 7.
   * Why V's own root: V's sit and sleep roots are the exact origins of the player workspots, which play the same clips as the generic NPC workspots on the same furniture
     (`COMPANION_SEATING.md`, "V's sit is a workspot"). An NPC workspot placed at V's root sits on the same cushion at the same depth.
3. **The shipped table** `mod/housemate-spots-data.lua`: measured entries only (a seed is promoted to the table after a recording confirms it).
4. **Verification when used** (every spot, once per materialization, spread by the shared spatial budget, `deferred` means "later"): floor ray within 0.3 m of the table height,
   the seat surface ray at the seat offset (the seating step 4 rays: height in the kind's band), nothing standing within 0.45 m (our own residents are known, strangers via one targeting query),
   a navmesh walk-up point within 1.5 m (the seating pre-check). A spot that fails twice is disabled for the session and logged (`Housemates spot-rejected {...}` in probe.log) so the owner can see which entry to fix.

### Spot data format

```
apartments = { h10 = { name='Megabuilding H10', district='LittleChina_VApartment', fact=nil,
    bounds = {min={x,y,z}, max={x,y,z}},   -- the interior volume, used for the ring spots and the despawn test
    door = {x,y,z,yaw},                     -- where V comes in; nothing is placed within 1.5 m of it
    spots = { {id, kind, pos={x,y,z}, yaw, vslot=false, approach={x,y,z}, side=nil, zone='living', source='probe', note} , ... } } }
```

Kinds and the component that plays them (existing ones marked *):

| kind | Meaning | Component / workspot | Needs |
| --- | --- | --- | --- |
| `couch` | a couch seat | `convai_sit_couch`* (`generic__sit_couch__sit_around__02`) | |
| `chair` | a chair, also a bench | `convai_sit_chair`* (`generic__sit_chair__sit_around__01`) | |
| `bar` | a stool at a counter | `convai_sit_bar`* | |
| `stool` | a free stool | `convai_sit_stool`* | |
| `lean` | standing at a counter or a wall | `convai_stand_bar_lean` (`generic__stand_bar_lean_front__stand_around__01`), `generic__stand_wall_lean_*` | new component (archive) |
| `stand` | standing in a room, facing a point (window, the room) | none: the actuator holds her (`stay`) and turns her once | nothing |
| `window` | `stand` facing a window | as `stand`, `yaw` toward the glass | measured |
| `sink` | at a basin | `generic__stand_low_sink___wash_hands__01`, `high_sink` | new, phase 3 |
| `bed` | one lying slot beside V's | `convai_lie_double_bed` (`generic__lie_double_bed__sleep__01..05`) | new, only for a bed that fits two |
| `chairsleep` | asleep sitting in a chair or at a counter | `generic__sit_chair__sleep__01`, `generic__sit_barstool_bar_lean_front__sleep__01` | new |
| `shower` | research | see finding 4 | research |

`vslot = true` marks the spot that is **V's own interaction root** (V's couch seat, V's bar stool, V's bed centre). Those are never given to a housemate, so V can always sit
and sleep where V used to. (`vslot` entries are used by the recorder as references to compute the neighbour offsets.)

New archive components follow the existing recipe (`assets/gestures/gestures.json` `seatWorkspots`, `scripts/Build-GestureAssets.mjs`: the vanilla workspot is copied under the
mod's path, random lists forced to 127 clips, the sequence made `loopInfinitely`, neutral facial idle) so a sleeper does not stand up by herself after one minute (the October 10 lesson).
`scripts/Verify-GestureAssets.mjs` and `bridge/gesture-seat-endless.test.mjs` are extended. A rebuilt archive needs a **game restart** and ships in the next Runtime.
Whether each of these workspots exists for all three companion rigs (woman_base, man_base, man_big) is checked in phase 0 with the same extractor that produced
`seat-workspots/summary.txt`; a missing rig makes that kind unavailable for that body type (she uses `stand`/`couch`).

### Tables

Coordinates are world metres (x, y, z), `yaw` is the quaternion's yaw about Z in degrees as the archive lists it (counter clockwise seen from above; the recorder fixes the convention
against `ToEulerAngles().yaw` before anything is promoted). **Confidence**: M measured on the game (the owner's seat), A archive furniture position (±0.3 m, no seat root), Q a quest marker (an NPC stood or sat there in the game's own scene), I inferred, ? unknown.

#### Corpo Plaza (`corpo`, floor z 49.2, bounds about x -1625..-1597, y 348..362) - best known

| id | kind | Position | yaw | Conf | Note |
| --- | --- | --- | --- | --- | --- |
| corpo-couch-v | couch | (-1602.30, 356.20, 48.62) | 18.5 | **M** | V's seat (the `player__sit_bench_lean_back_r_hand_on_back__talk__01` root). **vslot** |
| corpo-couch-2 | couch | V's seat + 0.66 m to V's left | 18.5 | M | The one other seat on that section (`COMPANION_SEATING`, "one seat, 0.66 m to V's left") |
| corpo-couch-3, -4 | couch | (-1601.09, 358.73, 48.62), (-1602.12, 358.71, 48.62) | ? | Q | mq055 partner markers `judy_start_pc_sofa`, `river_sofa_kitchen` on the L section; sofa mesh 1.89 x 0.90 at (-1603.56, 357.14, 48.63) yaw -60 |
| corpo-bar-v | bar | (-1608.05, 351.79, 49.40) | -170.6 | I | The scene's bar-stool workspot root (fitted origin, ±0.5 m). **vslot** |
| corpo-bar-1..3 | bar | stool meshes (-1607.53, 352.05, 49.4), (-1608.61, 351.91, 49.4), (-1610.13, 351.88, 49.4) | 102 / 77 / 137 | A | Three stools at the counter; one of the three is V's. Roots 0.5 m from mesh centres, to measure |
| corpo-chair-1 | chair | (-1598.91, 357.46, 48.63) | -30.5 | A | `corpo_office_chair_b` beside the sofa end |
| corpo-chair-2 | chair | (-1614.48, 351.22, 49.44) | -138 | A | second office chair near the bedroom side |
| corpo-bed-v | bed | (-1614.31, 358.39, 49.07) | 30 | I | V's lie root. Bed is a built-in platform about 5.0 x 2.9 m (nine pillows at (-1614.2, 359.5)). **vslot**. Fits two by size |
| corpo-bed-l, -r | bed | V's root +/- 0.8 m across the bed | 30 | ? | To measure with the edge scan |
| corpo-counter | lean | in front of the coffee machine (-1608.81, 349.09, 50.33) and the whisky glass (-1607.65, 351.5, 50.5) | ? | A | Kitchen counter, to measure |
| corpo-shower / mirror | research | (-1623.95, 352.79, 49.30) yaw 83.9, mirror (-1623.29, 355.54, 49.20) | | I | Player workspots, not NPC |
| corpo-window | window | not extracted | | ? | Recorder |

#### Megabuilding H10 (`h10`, floor z 123.06, bounds about x -1395..-1375, y 1260..1280)

All positions are 2.31 sector meshes (A), except where noted. The couch is the L shape found in quest sectors.

| id | kind | Position | yaw | Conf | Note |
| --- | --- | --- | --- | --- | --- |
| h10-couch-* | couch | segments: bend (-1376.41, 1267.79, 122.69) yaw 84, long arm pieces at (-1376.34, 1268.79) and (-1376.25, 1269.78) yaw 85.6, short arm pieces at (-1378.59, 1266.00) and (-1379.58, 1266.09) yaw -5; each middle piece 1.0 m wide | | A | About 5 seats along the L. **One is V's** (scene `johnny_default_sit_active` area); the recorder marks it `vslot` |
| h10-table | (reference) | (-1379.08, 1267.76, 122.66) | -95 | A | Low table in front of the couch |
| h10-desk-chair | chair | (-1386.05, 1274.38, 123.06) | -115 / 153 | A | Chair variants (`bar_lounge_chair_b/c`, `corpo_office_chair_b`, `poor_residential_chair_e`) swapped by `mq000_vs_apartment_decorations.questphase` |
| h10-stool | stool | (-1385.95, 1274.98, 123.06) | 146 | A | `poor_utility_stool_b`, 0.45 m high |
| h10-stand-johnny | stand | (-1385.26, 1272.44, 123.07) yaw -104; (-1389.25, 1268.10, 123.08) yaw 86 | | Q | Johnny's AI spots (`ws_johnny_default`, `mq033_johnny_fool_ws`) |
| h10-bed | bed | mattress `poor_mattress_a` (-1377.33, 1276.14, 123.29) yaw 174.8, 2.50 x 2.20 m; duvet variant 2.06 x 1.96 | | A | Fits two by size. V's lie root unknown (recorder). **vslot** |
| h10-window-bed | window | bedroom window (-1375.75, 1277.79, 123.36) yaw 85 | | A | At the head of the bed; a stand spot beside it, to measure |
| h10-living-window / counter | stand, lean | mq055 markers (-1377.6, 1271.25, 123.06) `river_window_to_sofa`; (-1384.84, 1270.41, 123.06); (-1381.49, 1277.37, 123.17) | | Q | Where partners walk to the window, the shelves and the bathroom |
| h10-shower / toilet | research | shower entity `mq000_shower` (-1383.76, 1278.03, 124.00) yaw -95; toilet (-1378.96, 1277.76, 123.12) | | A | |

Cat spots of quest q003 (23 `worldAISpotNode`s, sleep, lie, clean, eat) are not used: they are cat spots.

#### Heywood Glen (`glen`, loft floors z 86.95 and 91.2) - low confidence

Scene origin fitted from the shower and the bed meshes (partly circular). Meshes: mattress `rich_mattress_a_cloth_a` at (-1524.34, -977.02, 90.97) (the box was reported as 2.04 x 0.69 x 0.28, which does not say "double": **unverified**),
rain shower (-1528.6, -969.4, 94.56), toilet (-1528.57, -974.52, 91.58), stools at (-1522.31, -984.21, 86.95) and (-1533.54, -969.8, 86.96), small couch `bar_sofa_01_o_small` at (-1519.34, -977.76, 86.78),
office chair (-1518.97, -969.92, 86.95), a billiard table (scene entry `in_biliard`). Fitted workspot roots: chair (-1520.95, -977.6, 86.9), bed (-1524.3, -977.0, 91.19), shower (-1528.7, -969.6, 91.36), mirror (-1530.4, -972.5, 91.3).
Everything is a seed. Bed `fitsTwo` unknown.

#### Westbrook Japantown (`japan`) - low confidence

The prefab is a multi-floor block and the archive does not say which floor is V's flat. Furniture exists at z 12.2, 16.2, 28.2. Bed `int_ent_mb_apartment_bed_a_l400` at (-782.33, 988.53, 16.21) yaw -171.4 (mesh 2.27 x 4.0 including an alcove), mattress `poor_mattress_b` (-781.15, 986.65, 16.73);
couch `vs_apartment_couch_middle_a` (-783.71, 977.22, 28.21), stools (-784.24, 972.88, 28.21) and (-782.23, 981.61, 28.2), toilet (-781.64, 970.27, 28.17). Scene-local workspots only
(sit chair, guitar chair, barstool, bed, shower, sink). Everything is a seed; the floor must be settled by the recorder.

#### Watson Northside (`north`) - unknown

Interior `interior_-48_69_0_0` extracted but not scanned (furniture listed: wardrobes, a mirror). Scene-local workspots: keyboard chair, bed, shower, sink. Everything is a seed.

**Honest summary.** Corpo Plaza has one measured seat and a good furniture picture. H10 has an excellent furniture list but no seat roots. Glen, Japantown and Northside are unlocated
beyond a block of space. The first build ships H10 and Corpo Plaza spots, and the other three until measured use the **procedural fallback** below (standing/leaning residents on sampled navmesh points, no seats, no bed). Each apartment becomes
"fully furnished" when its recording is promoted into `housemate-spots-data.lua`. This is why phase 0 is a measurement phase.

### Procedural fallback (no table, or an unmeasured apartment)

Bounded sampling on the navmesh inside the apartment bounds: rings around the interior centre, candidates at least 1.5 m from the door, at least 1.0 m from the bounds edge (walls), at least
1.2 m from any other resident and from V, floor within 0.3 m of the apartment floor (`bounds.min.z`, no stairs), clearance for the body (`companion-clearance`),
not inside a corridor (width test: four rays at 0.9 m). They are `stand` spots with the room's centre as the facing point, so residents "stand around". They are chosen
once per materialization (a handful of navmesh queries on the shared budget) and nothing is stored. This also covers an overflow housemate when every table spot is taken.

## Assignment across many housemates

Inputs: the residents to materialize (`homes` filtered by apartment) and the apartment's spot list. Rules, in order:

1. **V's slots are never given** (`vslot`), nor any spot within 1.0 m of V or of a spot V is using (if V sits, the couch spot beside V stays free of anyone else for the seating code's companion logic).
2. **Order**: residents sorted by a stable hash of the profile key plus the day, so each housemate tends to the same corner of the room (character), not random every visit.
3. **Kind quota**: with `S` free sit spots (couch, chair, bar, stool), `N` residents: `sitters = min(N, S)`, and from the rest and up to one extra for variety (chance 0.25 when `N >= 3`) the others stand. "Most sit wherever possible, some stand."
4. Each resident draws a kind from weights: sit 0.62, window 0.12, lean (counter) 0.10, stand (other) 0.12 (zeroed when the apartment has none), limited by free spots of that kind; sit spots are consumed first by the residents with the highest sit weight in the day plan.
5. **Spacing**: two residents are never assigned spots less than 0.9 m apart (centre to centre) unless on the same couch (0.66 m seats), and never two in the same `zone` beyond the zone's `capacity` (a couch group, the bar, the window area).
6. **Faces**: a sitter on a couch next to another sitter is fine. A stander at a window faces the glass. Two standers are not placed facing a wall at less than 1 m.
7. **Overflow**: when the table runs out, procedural stand spots (above). **There is no cap on bodies and no rotation** (owner, 2026-10-25: all housemates are present at once, "people will not spawn that many"). The idle work stays cheap
   (one step a second for everybody settled, nothing per frame) and the live test measures it with the biggest group the owner has.
8. A re-plan (a change of spot) re-runs the assignment for that one resident only, with the others fixed.

## Routine state machine

Per resident, owned by `mod/housemates.lua`. The time unit is real seconds of play (frozen while the game is paused or loading: the module's clock adds the frame delta the 10 Hz tick already gets, zero in menus). Game hour comes from the game clock (the outfits module reads the same value).

```
 (virtual) --V enters the flat, conditions ok--> materializing --spawned, verified spot--> settling
 settling: walk (AIMoveTo through the actuator) to the approach point, play the workspot (PlayAtResourcePosition, 0.5 s slide)
     --> at(spot) { sit | lean | stand | window | sleep | doze }
 at(spot) --dwell over (random 6 to 18 min for a sitter, 2 to 6 for a stander, none while asleep)--> choose next -> leaving-spot -> settling
 at(spot) --V talks to her--> engaged (keeps the pose, turns eyes and head to V; a sleeper wakes and stands first) --talk over--> at(spot)
 at(spot) --pair chat picked--> chatting (keeps the pose, looks at the partner) --> at(spot)
 any --recall (Join V's Party)--> joining (leaves the workspot with the native fast exit, role set) --> party
 any --scene / combat / quest reserved--> held (hidden) --clear for 3 s--> at(spot) / settling
 any --V leaves for 20 s--> unloading (bodies deleted)
```

* **Day plan** (game time, 06:00 to 22:00): sit 0.62, window 0.12, lean 0.10, stand 0.12 as above; weights change a little by hour (morning: lean at the counter more; evening: sit more); nothing shower related in phase 1.
* **Night** (22:00 to 06:00): each housemate has a **bedtime** in [23:00, 01:30] and a **wake time** in [06:30, 08:30], both from the hash of the profile key, so they do not all fall asleep in the same minute. Until her bedtime she follows the day plan. Then: bed (if the apartment has a verified `bed` spot that fits two and a free slot), else
  `chairsleep` (asleep sitting at a chair or counter stool), else she stays on the couch (sit, awake; "stay up"), else stands. A sleeper does not take part in pair chats and is not offered group talk until woken.
  Waking by V's talk: she exits the workspot (fast exit) and stands; one line later she may sit again.
* **Not while V looks** applies to anything that would **pop**: a spot change is a walk (visible walking is natural); the exit from a workspot is the game's animation; a sleep or wake needs no hiding. Only clothes use the outfits "nobody is looking" rule.
* **Time jumps** (V sleeps through hours: game hour advances by more than 0.75 in one step): re-plan every resident, no visible teleport (they walk).
* **Dwell and churn**: the number of spot changes per hour is bounded (a resident changes at most once per 3 minutes), so a flat of 6 does not look restless and the shared spatial budget is never starved.
* **Shower**: phase 3 research. If a pose can be played for all body types, a morning/evening visit of 2 to 3 minutes at the shower spot is added. Until then the bathroom is simply not used.
* **Cost**: the machine steps at 1 Hz while all residents are settled, 4 Hz while any is walking or changing pose; each step reads at most a few native values per resident (workspot state, position). No step runs when no resident exists.

## Sleeping

* **A bed counts only if it fits two.** Per bed the table stores `fitsTwo` (measured width of the sleeping surface at V's lie root, at least 1.8 m with V at the centre, or V's lie root at one side with at least 0.9 m left on the other), the NPC slot (a lateral offset from V's lie root, about 0.6 m, on the roomier side), and the head direction. Runtime check: the edge scan rays (6 rays) must agree with the table before she lies down.
  Seeds: Corpo Plaza platform 5.0 x 2.9 m: yes by size. H10 mattress 2.50 x 2.20: yes by size. Glen: unverified. Japantown, Northside: unknown. Unknown means "does not use the bed".
* **V can still sleep.** V's lie root is a `vslot`: never used. A sleeper takes the side slot only. A second sleeper is allowed only on a bed wide enough for three (Corpo Plaza).
  Live check: V's own sleep interaction (the time skip scene) starts with her in bed and V's body does not clip hers. If it clips, a sleeper gets up when V comes within 2.5 m of the bed while looking at it (the interaction prompt is the signal) and lies down again after V has gone to sleep or left. The design never blocks the interaction.
* **No double bed**: `chairsleep` at a chair or counter stool (vanilla workspot exists), else sit-awake on the couch. A couch lie-down does not exist for generic NPCs.
* **Also uncertain**: the lie-double-bed workspot's root may be the bed centre or a side: the NPC slot offset is tuned live.

## Party transitions

All through the one body: `companions.joinVisitor` (immersive branch) and its mirror.

| From -> to | How |
| --- | --- |
| Home -> party (**tag along**) | `Join V's Party` action (offer kind `home`, `members` = residents in earshot, `all` or named). For each target: leave the workspot (native fast exit, wait for `inWorkspot` false up to 1.5 s, step out as the seating code does), release the actuator, `joinVisitor(serial)` (follower role, `state = 'ready'`, no respawn), `convaiOutfitApi.setHome(key, false)` (she changes out of home clothes when nobody is looking), notice "{name} joins you." Slot and lane come from the normal `groupFrame`. If the party is at its size limit: refused in character (`reason = 'full'`). |
| Party -> home (**rest / leave / stay** while V is in **her** apartment) | The existing `Leave V's Party` action. The game, not the model, decides what it means from the offer: if `member.home == the apartment V is in`, she is **released to her routine** (below), otherwise she **departs** (walks away, removed out of V's view, `companion-adoption`) and is home virtually. The model's job is only to decide V meant it. |
| Party -> home, in another of V's flats (**owner, 2026-10-25**) | **She asks**: the leave offer's member carries `away`, `homeName` and `hereName`, and the character is told not to leave yet but to ask "want me here, or back at my place in Glen?". The game remembers the question for 10 minutes. V's answer is the next turn: "back" is the ordinary `Leave V's Party` (now marked `confirmed`: she departs and is home virtually), "here" is `Stay At <this flat>` (she moves house to this flat and is released into its routine). A leave packet for an `away` member that is not `confirmed` is refused by the game. V on the street (not in any flat): no question, she just leaves. |
| Party -> routine ("release") | Reverse of `attachFollower`: remove the follow behaviour (`ai:SetAIRole` back to `AINoRole`, the check `attachFollower` already makes on spawn), cancel formation/tactic/transport/gesture/seating ownership of her (`companions.bodyAnimation.release`, `stopPace`), `entry.state = 'visiting'` with `entry.home`, then the routine places her. `setHome(key, true)`. **Uncertain**: that a copy accepts `AINoRole` after `AIFollowerRole` and then answers `AIMoveTo` commands (live check 5). Fallback: delete the body when V is not looking at her and materialize a fresh resident at her spot. |
| Dismiss (manager Current party) | Same as the leave action: routine if V is in her home flat, else departure. A housemate is never deleted from `homes` by a dismissal, only by `Move Out`. |
| Fast travel while a resident is materialized | Residents are deleted before the capture, like visitors (`beginFastTravel`). They are virtual again; nothing to carry. |
| Fast travel into an apartment | The world-ready check materializes the residents (see "Materialization"). |
| Death / load | Party gone as today; housemates virtual, materialize when V is home. |
| She is recalled while V is away from the flat | That is an invitation (manager Invite, phone, J key): the existing instant path, or the immersive appointment when that setting is On. Her `homes` entry is untouched. |
| She is in the party and V enters her flat | Nothing happens. She stays in the party until released. (She sits beside V by the existing seating code.) |

## Group chat

* **Candidates**: residents within 20 m of V in the same apartment join `conversationCandidates` (via `visiting` support), after the addressed person and the party, nearest first. Speakers per round stay at **3**
  (`group-chat.lua choose`, `#selected < 3`): that cap exists for latency and cost and is kept.
* **The action covers everyone addressed, not everyone who replies.** The offer for the first speaker's turn lists **all** eligible members, not the three speakers:
  every party member plus every resident in earshot (up to 12 named entries; "everyone" always means all of them). The lease is the audience as the game knew it when V sent the message. The first speaker answers with `all`, or the names V used; the game validates each target against the offer and applies the action to **all** of them in one step, in one batch notice
  ("{names} are at home" / "{names} join you"). Only three of them reply, and that is fine.
* The cap of 3 in `A.leaveOffer` (`#members < 3`) is lifted to 12 for this offer kind. The bridge screen and the model prompt gain the member list with their state (`home` / `party`) and the rule "only those V addressed".
  Words like "everyone", "you all", "guys", or listed names address them. A name of someone not in earshot is not addressable.
* **Voice and text** are the same: `group-voice` and `group` sources already lease the offer on the first turn only (`input.group.index === 1`).
* Mixed commands ("Judy, rest. Panam, come with me") are two actions in one answer only if the model emits both; the lease allows one action per request (existing rule), so the second needs a second message. The prompt says so.
* **Pair chat pauses** while any group round runs and ends cleanly at the next line boundary.
* A resident joining a group round keeps her pose (seated, standing). A sleeper is skipped (not a candidate) unless addressed by name: then she wakes.

## Pair chat

Housemates talk to each other while V is home and has released them from the party. Goals: one conversation at a time, a random pair, 7 to 8 lines in all, then a pause, V can join in or call someone back, and no requests, no connections and no lines whenever V is not at home.

### Conditions to start

All must hold (checked at the scheduler's step, once a second, only while two or more residents are settled in the flat V is in):

1. V is in the apartment (district record), not in combat, a scene, dialogue, a call, a menu, a vehicle, or the phone; no conversation, group round, phone message or automatic reaction in progress.
2. At least two residents are settled (not asleep, not walking, not joining, not held, not in a talk with V), within 12 m of each other, and both within 25 m of V (V can hear).
3. The pause since the last chat ended has passed (2 minutes) and the Companion speak-up level allows another chat this hour.
4. Neither resident is in the party.

When V is not in the flat nothing of this runs: the scheduler is not even called, so no request is made, no connection opened and no line spoken.

### The chat

* **Pair**: random among eligible pairs, weighted down for a pair that chatted recently (so the same two do not repeat) and up for residents who have not spoken. A nearby pair is preferred (shorter turn-toward).
* **Turns**: A speaks, B answers, A, B, ... up to **8 lines** in total (both speakers). The prompt tells the speaker "this is line n of 7", and line 7 or 8 is a closing remark. A hard stop at 8 lines even if the model would continue. If the line budget (below) runs out earlier the chat ends after the current line; a half chat is fine.
* Each line is an **automatic reaction** with `reaction.kind = 'house'` (a new kind beside `head`, `loot`, `battle`, `addon` in `mod/init.lua`), spoken by the speaker's body with lip sync, subtitles and voice through the normal path (the addon voice code is the template for a non-Convai speaker; the speaker's own provider and voice are used). The partner's previous line travels in `group.heard`-shaped context, so the next speaker answers it. The request carries `chatter = {n, of, topic}`; `bridge/house-chat.mjs` (new) writes the instruction: who they are talking to, where (the apartment, the time of day), that V is nearby and can overhear, the topic seed on line 1, and the length rule. Topic seeds come from a short pool plus context the turn builder already has (time, weather-free, what V recently did through the "Also with V"/company notes), never from V's private memory.
* **Movement and gaze**: each speaker keeps her pose and turns eyes and head to the partner (the gaze code that points at V is given the partner's entity as the target; only for the length of the chat). No gestures beyond what seated/standing talk already plays.
* **Only one chat at a time**, enforced by a single `chat` slot in the module (and by the shared proactive limiter below).

### Interruptions

* V presses the talk key / looks at one of them and talks: the chat ends after the current line finishes (the line in the air is not cut). The addressed one answers V. The partner is added to V's group context as "was talking with {name}" so V can join in, and a group round with both is possible as usual.
* V calls someone back to the party: the normal `Join V's Party`; the chat ends.
* V leaves, a scene or combat starts, or one of them is hidden or deleted: the chat is dropped at once, no cooldown penalty beyond a short one.

### Rate and budget (owner, 2026-10-25)

* **One chat at a time**, at most 8 lines (the speakers aim for 7 or 8; the last line is a closing remark).
* **A pause of 2 minutes from the end of the last chat**, on every provider. There is **no special Convai share**: the idea of a `HouseChatAllowance` beside `RemarkAllowance` was dropped.
* The **Companion speak-up** level (Off, rarely, normally, often; the setting is changing names on `feat/dynamic-info-speak-up`) caps the chats per real hour: Off none, rarely 2, normally 4, often 6 (about 2, 4 and 6 an hour as the setting says). Off means no housemate chat. `mod/housemate-chat.lua` accepts the old names (rare, medium, normal) too.
* The shared arbiter of unprompted lines (Johnny, companions speaking up) is used through `limiter.allow/note` when the speak-up branch provides it (`convaiProactive`); until then only the pause and the level apply.
* V's own requests come first: a chat never starts while any request of V's is in flight, and a line that is only waiting for the channel is cancelled the moment V talks.
* Connections: the existing "Auto-connect nearby characters" warms the characters V looks at or stands near, residents included, so a talk with a housemate opens fast. A chat line cold-opens its speaker's connection like any first line; that is the only cost of a chat start.

### Interface for the shared limiter

```
limiter.allow(kind, lines)   -> true | false, reason      -- kind in 'johnny', 'speakup', 'house'
limiter.note(kind, lines)    -- after the lines were actually requested
limiter.level()              -- the companionSpeakUp level
```

## Home clothes

Against the outfits branch API, nothing copied:

* A resident is created in the right clothes by `companions.spawnOutfit(record, key)` (the outfits module already returns the home look when `isHome(key)` is true), so a materializing housemate wears casual clothes from the first frame, **not a visible change**. Before spawning a resident the module calls `convaiOutfitApi.setHome(key, true)`.
* `convaiOutfitApi.setHome(key, false)` on recall (she changes into her outings look when nobody is looking, which the outfits module already guarantees: it checks the game's frustum test and never acts during a fight, scene, call, ride or gesture); `setHome(key, true)` on release; `nil` (follow V's whereabouts) is not used for housemates.
* **Two small requests to the outfits branch**: (a) `companions.outfitRows` should also return the `visiting` copies that belong to housemates (today it lists ready copies), so day/night looks keep working for a resident at home; (b) `outfits.created`/`forget` are called for residents too. Both are one-line changes there and are listed in "Files".
* A character with no curated home outfit simply keeps her usual look (`hasHomeOutfit` false), as in the outfits design.

## Quest and scene safety

Principles: housemates are ours (tagged managed copies), quest logic never refers to them, and **whenever the game might be directing the flat, they are not in it**. The cheapest signal wins, the safest default is "gone".

Signals (all low rate, none new):

| Signal | Source | Use |
| --- | --- | --- |
| Scene tier of the player state machine (`PlayerPuppet.GetSceneTier`, already read by `mod/battle-observer.lua`), dialogue (`SceneSystemInterface:IsEntityInDialogue`), choice hub, phone call, vehicle | native, polled at 1 Hz while residents exist | Held mode |
| Quest facts that mark a scene or phase in an apartment (names below), read as `GetFactStr(...) > 0` | the quest data (listed from the cooked phases) | A **reserved** apartment: no materialization, and held if already there |
| `IsActorInWorkspot(player)` with the apartment's scene tier 3/4 | V's own couch/sleep/shower interaction | **Not** a quest scene: residents stay (they must not take V's seat) |
| A game-placed twin of the same profile in the flat | a bounded native query for NPCs of her record within 25 m, once at materialization and every 10 s | She steps out (the real Judy is in the scene, so ours is not) |

**Reserved facts** (a reserved apartment hosts no housemates while any is above 0):

* Any apartment: `mq055_02_active` (romance visit chain) and `mq055_02_<place>_active` for that place, `mq055_02_<place>_<char>_active`, `dlc6_apart_<x>_purchase` and `_purchase_setup` (purchase tour), `web_apartment_website_start`, `mq055_apt_interactions_off`.
* H10: `q001_in_v_room` (prologue), `q001_start_stanley_wakeup`, `q101_p2_v_room` active, `q305_johnny_scene_active`, `mq000_*` and `q003_*` scene flags as listed in the cooked phases; `apartment_on` is a global "apartment features on" flag (set by q001 and others), **not** an in-apartment flag, and is read only as: `apartment_on == 0` means the home features are off, so no housemates anywhere.
* Glen: `mq055_04_intimate_action_on`, `mq055_heywood_*`. Japantown: `mq055_03_*`. Northside: `mq055_02_northside_*`, `mq055_northside_shower`. Corpo Plaza: `mq055_05_downtown_activities_off`, `mq055_downtown_*`.
* Plus a generic rule: the main-quest wake-up and early V-room phases: before `q001` is finished (fact `q001_done` or equivalent, found during phase 0) there are no housemates at all. (Nobody can invite anyone that early; this only stops a stale fact from materializing someone in the prologue.)

The exact fact list is regenerated from the cooked quest phases by a small script in phase 0 (`scripts/Extract-ApartmentFacts.mjs`, reads with the WolvenKit CLI as the research did) and kept in `housemate-spots-data.lua`, so a game update changes data, not logic.

**Held mode**: on a scene starting while she is materialized (tier 3 or more with V not in a workspot, dialogue, call, or a reserved fact turning on), within the next step: stop pair chat, hide her (the runtime visibility used by `companion-adoption` hiding, `setVisible`, plus an AI hold), no deletion. After 60 s of continuous held mode, or a quest that moves V out of the flat, delete her. When the condition has been clear for 3 s she is shown and resumes. If she was deleted she materializes again when V is home and the apartment is not reserved. The goal is that a scene's staging never meets a second body, and that nothing the scene counts on (doors, props, markers) is blocked by a standing NPC.

**Never in the way**: no spot within 1.5 m of the door, of a scene marker position listed in the quest data (the mq055 and Johnny spots above), or inside a corridor. Procedural spots obey the same exclusion list.

**Combat in the flat**: residents stand up at once (fast exit) and are deleted; they come back 60 s after the fight and when V is home. They are friendly copies and not part of the fight.

**Her record in the story**: if a profile's character is dead in V's story (the mod already knows through the dialogue/knowledge state) she is not eligible (the invite rule). If she dies later, the game does what it does; her `homes` entry stays and she is not materialized while the real character is recorded dead (live check; edge-case row).

## Materialization, performance and unload

### When bodies exist

Housemates exist **only while V is in the apartment or has just left it**. Outside, they are data: the registry and nothing else.

* **Trigger**: the district record changes to the apartment's record. Event driven: one `ObserveAfter` on the district-entered handler (`PreventionSystem.OnDistrictAreaEntered`, the event `DistrictManager` pushes), which runs only when V crosses a district volume, plus one check at world ready (loading a save inside the flat, fast travel into it) and a 5 s safety re-check **only while bodies exist**. With no housemates (`next(homes) == nil`) the hook returns at its first line.
* **Pop-in**: bodies are created when V enters the flat's volume and take about half a second to attach, then walk or slide to their spots. At the door V sees the flat as it loads. The first choice is spots out of V's view; a spot V can see is filled directly (placed at the approach point, workspot slide). Whether this reads as a pop is live check 6. A pre-load radius (materialize while V is in the corridor or lift, hidden by the door) is a constant to turn on if needed, because the interior streams in only near it (live check 7: an entity spawned before its interior is loaded may have no floor).
* **Spawn**: through the party queue's quiet job, without a party reservation and **without the conversation preparation** (`companions.canSpawn` gets a `resident` kind that skips the readiness receipt, since the body is not conversation-ready). The connection for talking is prepared lazily: when V looks at her for 1.5 s within 4 m, or addresses her, or a pair chat picks her (the existing request, cold open as for any world NPC on first talk). This keeps the number of warm connections at most 3 however many housemates exist.

### Frame cost (FPS first)

| Part | Cost |
| --- | --- |
| No housemates | the hook's first line; world ready: nothing |
| Housemates, V elsewhere | the hook's first line (a table check and one string compare per district crossing), no timers |
| Bodies exist | the module step: 1 Hz settled / 4 Hz moving, from the existing 10 Hz tick via a counter (like the outfits tick); no per-frame call |
| Spot verification | a few rays per spot, once per materialization, on the shared spatial budget |
| Workspot play | the same calls the seating code makes today (one device entity per sitter) |
| Pair chat scheduler | a counter; one check every 5 s while two or more are settled |

Nothing is called from `onUpdate` per frame. Movement is AI commands only (walks through the actuator). The only AI teleport is the seating step-out's emergency one that exists today, and only when unseen.

### What is unloaded and when

| Trigger | Released |
| --- | --- |
| V out of the flat for 20 s | all resident bodies (`deleteOwnedCopy`), their workspot devices (tag sweep), pending spot checks, the chat slot; the spot data module is dropped from memory 30 s later |
| Fast travel out | immediate (the visitor deletion in `beginFastTravel`) |
| World end / load | everything; `homes` is reloaded from the new save's facts at world ready |
| Last resident gone | connections prepared for residents; the limiter's local state stays (tiny) |
| Feature never used | nothing is loaded: `mod/housemates.lua` is `dofile`d lazily on the first non-empty `homes` or the first `home` offer |

## Settings

None for the feature. The owner prefers none unless needed, and nothing here needs one:

* Pair chat frequency follows the existing **Companion speak-up** setting (Off disables chats).
* Moving in is a conversation act, moving out is a conversation act or the manager row.
* Every tunable is a named constant at the top of the module (gaps, dwell times, day weights).

If the owner wants a master switch it is one row (`housemates`, On by default) in the same Settings page as Companion speak-up; it is not proposed.

## Many housemates

* **Housemates**: unlimited (the registry is a table of keys), and **all of them are present at once** in their flat (no cap on bodies, no rotation: owner).
* **Cost per body**: one managed NPC; no connection until someone talks to her; no gesture or expression ticks (those key on `ready`); the face writer's rows (`expressionActors`) include residents only while they speak.
* The controller steps once a second for everybody settled and four times a second while anybody walks, spawns or changes place. The live test measures FPS with the largest group available.

## Edge cases

| Case | Decision |
| --- | --- |
| V names an apartment V does not own | Not in the offer; the model cannot pick it; the game would refuse it again. She says she doesn't know the place (prompt line) |
| Same character already lives elsewhere | `Stay At` moves her house; the old body (if any) is deleted |
| Two housemates asked the same question at once (group) | One lease per request: the first speaker's action applies to all addressed members; nobody acts twice |
| Housemate is a character with no spot kind she can use (wrong rig for a workspot) | That kind is skipped for her; she uses `stand` |
| V takes the couch seat a resident is on | Impossible by design: the V seat is `vslot`. If the table is wrong and a resident sits in V's way, the interaction still works (the game does not check NPCs); the recorder fixes the table. Live check 9 |
| V sits and a party companion wants the seat beside V (existing seating) while a resident sits there | The seating code already refuses an occupied seat (targeting query). Residents are not seating's business |
| Game-placed twin | The resident steps out until the twin is gone (see Quest safety) |
| V is in a different flat from her home and she is in the party | Party behaviour only |
| V leaves her home mid-chat | Chat dropped at once |
| Save mid-chat / mid-sleep | Nothing saved except `homes`; load puts her at the day's start state |
| V changes the language, the provider or the voice | A chat in progress finishes its current line, the next chat uses the new route |
| Voice/provider unavailable for a speaker (Local AI loading, Convai quota) | No chat starts. A chat in progress ends after the current line |
| Local voice fails / cloud voice (house rules) | Unchanged: a failed local voice goes to text only, never to cloud; a resident in a cloud-voice setup loads no local model |
| Housemate dies (combat) | The `homes` entry stays. She is not recreated until the next flat entry; if the game marks her dead she is not materialized (to verify) |
| Her profile is disabled in the manager | She is not materialized; the entry stays |
| The character editor deletes a custom character | Her fact is stale and harmless; no body |
| A resident is attacked / V attacks her | The existing hostile handling of managed copies; she is deleted after the fight, remains in `homes` |
| Two apartments, V moves between them without leaving a district | Not possible (each is its own volume) |
| Many housemates in one flat | All are present; the places run out, the rest stand on procedural places (Assignment, rule 7) |
| Bed exists but the width scan disagrees with the table | The bed is skipped for that session and logged |
| Apartment with no data yet (Glen, Japantown, Northside) | Procedural stand spots only; no sleeping in the bed; `chairsleep` and `couch` unavailable |
| Upgrade 2.31 to 2.5 changes furniture | The runtime verification rejects a bad spot (logged); data fixes follow |

## Both game versions

All calls named are used by shipped code on both builds (placement, actuator, seating, gestures, outfits, groups) or are scriptable names present in both script sets. The
archive positions come from the 2.31 install: WolvenKit 9.0.1 cannot read the 2.5 streaming sectors (they store merged "cooked" node types it does not know). Quest facts, scenes and
phases were read from both and agree. Whether any 2.5 patch moved an apartment's furniture is a live check (the verification rays would reject a spot that moved). `GameVariant.reds` stays the only redscript that differs; nothing in this feature needs redscript.

## Files to touch

New:

* `mod/housemates.lua` - registry, materialization, assignment, routine state machine, pair chat scheduler, limiter shim. Pure with injected seams so the tests run it without a game
* `mod/housemate-world.lua` - the game side: district, facts, rays, workspot play (reuses `companion-seating`'s `native`), outfit and visibility calls
* `mod/housemate-spots-data.lua` - the apartment tables and reserved fact list (data, loaded lazily, dropped after 30 s)
* `mod/housemate-survey.lua` - the development recorder and scanner (Developer mode only; listed in `scripts/development-files.json`)
* `bridge/house-chat.mjs` - pair chat prompt, line rules, topic pool, `chatter` validation
* `bridge/home-requests.mjs` - screen and tags for the `home` offer (stems in the game's menu languages), like `meet-requests.mjs`
* `scripts/Extract-ApartmentFacts.mjs` - regenerates the reserved fact list from the cooked quest phases (WolvenKit CLI, read only)
* `docs/HOUSEMATES.md` (this file, updated as work lands)

Changed:

* `mod/companions.lua` - a `home` field on visiting copies, `residents()`, `releaseToHome(serial)` (role removal, state back to `visiting`), `joinResident` (wraps `joinVisitor`), `canSpawn` kind `resident`, `conversationCandidates`/`identity` accept residents (already `visiting` on the immersive branch), `outfitRows` includes residents
* `mod/companion-seating.lua` - export the `native` adapter (play, exit, step-out, body clear) so the resident code reuses it, not a copy
* `mod/companion-adoption.lua` - leave offer members carry `home` and the cap is 12 for this kind; the release outcome is chosen by the game; departure for the away case unchanged
* `mod/gameplay-actions.lua` - the `home` offer lease (join, leave, stay, move out), validation against the offered ids, one batch notice
* `mod/init.lua` - lazy `convaiHousemateTick` beside the outfit tick, the district hook, world-ready check, the `house` automatic reaction kind, offers on private/group/phone turns, reset on session end
* `mod/phone-chat.lua` - the `home` offer on a phone turn, action in the reply (as the meet action)
* `mod/turn-context.lua`, `bridge/turn-context.mjs` - the housemate note ("you live at V's place in ...", "V asked which apartment"), "at home with V: ..." in the company list
* `mod/manager.lua`, `mod/manager-ui.lua`, `mod/manager-party.lua` - Move out row (phase 2), quiet resident spawn job without a reservation, dismissal semantics, locales
* `mod/locales/*.lua` (15) - notices and the manager row (`scripts/Extract-UiCatalog.mjs --check` green)
* `bridge/companion-actions.mjs`, `bridge/text-actions.mjs`, `bridge/text-action-words.mjs`, `bridge/phone-chat.mjs` - the `home` offer, the new actions, the member list prompt, caps
* `bridge/shared-key-guard.mjs` - `HouseChatAllowance`; `bridge/convai-bridge.mjs` and friends for the `house` reaction kind and the chat request type
* `assets/gestures/gestures.json`, `mod/gesture-catalog.lua`, `scripts/Build-GestureAssets.mjs`, `scripts/Verify-GestureAssets.mjs`, `bridge/gesture-seat-endless.test.mjs` - the new components
* `bridge/game-state.mjs`, `packaging/runtime-exchange.json` - the mirror file
* `docs/COMPANION_SEATING.md` - the apartment label fix; `docs/COMPANION_INVITATIONS.md`, `docs/MANAGER_UI.md`, `docs/SETTINGS_MATRIX.md`, `docs/PHONE_CHAT.md`, `README` notes

Not touched: `mod/diagnostics.lua`, `scripts/Test-GameInput.ps1`, `docs/DEMO_VIDEO_PLAN.md`.

## Phases

**Phase 0 - measure and qualify (built).** The recorder and scanner (`mod/housemate-survey.lua`, through the gesture probe), the quest-fact extractor, the saved-fact check, the new archive components and the build changes they need, the label fix. Output still to come from the live run: the measured spots of the five flats and the go/no-go on facts.

**Phase 1 - the feature (built).** Registry and facts; ownership; the offers and actions (stay, rest with the question, recall, move out) on private, group and phone turns; materialization and unload; assignment and routine; party transitions; home clothes behind a guard; quest/scene safety; the data of H10 and Corpo Plaza, the procedural fallback for the other three.

**Phase 2 - the life (built).** Sleeping (beds that fit two, a chair to doze in), pair chat, the welcome line when V comes home after a long absence, the Move out row in the manager.

**Left out on purpose.** The shower (owner: out; a sink wash with the generic pose is in the archive components but no sink spot is recorded yet), Dogtown, gaze between the two chatters.

## Test plan

Unit (pure Lua with injected seams, the `bridge/companion-seating.test.mjs` Fengari approach):

* **Assignment**: N residents x apartment tables: V slots never given, spacing, quota (most sit, some stand), overflow to procedural places, stability by hash.
* **Routine machine** with a fake clock and fake game seams: day plan weights, dwell, churn limit, bedtime/wake hashing, bed only when `fitsTwo` and verified, chair sleep fallback, time jump re-plan, talk wakes a sleeper.
* **Persistence**: fake fact store, write on move in/out, read at world ready for every known key, rollback (older save's values), a deleted custom character, unknown keys.
* **Offers**: bridge offer parsing, the apartment choice rules (named, here, only one, ask which and the follow-up), unavailable reasons, `all` and named targets, cap 12, tag screens in every menu language (reuse the fixtures of `text-action-words`).
* **Group**: 3 speakers cap vs 12 audience members; the action applies to all addressed even when two never reply; one batch notice; pair chat pause.
* **Party transitions**: join/leave state changes on the real `companions.lua` under the fixture (as `immersive-companions.test.mjs`): role set/removed, `homes` untouched by dismiss, fast travel deletion, join refused when full, outfit calls (`setHome`) recorded.
* **Pair chat**: one at a time, random pair respects exclusions, exactly at most 8 lines, closing flag at 7, cooldown per level, limiter refusal delays, allowance exhaustion ends after a line, interruption by V, drop on scene/combat/leave, no start while a request is in flight.
* **Safety**: reserved facts per apartment, tier/dialogue, V-in-workspot exception, held mode hide/delete/restore timing, game-placed twin, combat.
* **Performance/unload**: counts of native calls per second for 0, 1, 6 residents settled and moving (bounded), zero calls with no housemates, no entity, device or connection left after leaving (leak test using the fake entity system), hook first-line cost.
* **Data validation test** for `housemate-spots-data.lua`: unique ids, valid kinds and components, every apartment has bounds and a door, every table has at least one `vslot` where it has a bed/couch, no spot within 1.5 m of the door, `fitsTwo` only with a measured width, all fact names well formed.
* **Bridge**: `house-chat` prompts (line rules, closing, topic), `HouseChatAllowance` (cap, day roll, signed record), shared-key interplay, `home-requests` screen.
* `scripts/Extract-UiCatalog.mjs --check`, the gesture archive verifier with the new components, the packaging test that the mirror file is in the state class.

## What only a live run can settle

1. **Facts**: `SetFactStr` of a mod fact survives save/reload, an older save returns the older value, a new game starts clean; the four purchase facts read 0 on a save that owns none and 1 on one that does (the mq055 dev chain does not run in retail).
2. The recorder's yaw convention; V's seat roots in H10 (which L-couch piece is V's), Corpo Plaza's other seats; Glen, Japantown (which floor), Northside have any usable positions.
3. NPC workspots at those roots sit right (not floating, not in the backrest): the seating tuning carries over to a fixed seat; the second couch seat, the stools at the counter, the office chairs.
4. The new workspots exist and play for all three rigs: `lie_double_bed__sleep__0N` (which side/offset the root is), `sit_chair__sleep`, `stand_bar_lean_front`, sink wash.
5. A copy that received `AIFollowerRole` accepts `AINoRole` again and then takes `AIMoveTo` (release to routine); otherwise the respawn fallback.
6. Pop-in when V enters the flat or fast travels in; whether bodies should be created before V is inside.
7. An entity created while its interior is not streamed in has no floor.
8. V's own **sleep** with a resident on the other side of the bed: no clipping, the time skip works. V's **sit** on the V seat with residents on the neighbouring seats.
9. Reserved facts: do they actually flip in the scenes (H10 prologue, mq055 visits, purchase tour)? A resident is never in the way of a scene (watch one of each); the game-placed twin check finds the real Judy.
10. Group action with 5 housemates and 3 repliers; the member list stays under the prompt budget.
11. Pair chat: two real residents, voice and lip sync from a seated pose, gaze at the partner, line count, cooldown, V joining in, the Convai usage counter before and after.
12. Home outfits: she appears in casual clothes at materialization, changes only when unseen on recall, no flash.
13. FPS with 6 residents settled and moving, and with housemates registered but V elsewhere: unchanged.
14. After a restart: the registry is back; load an older save: older registry.

## Uncertain

* Positions are archive seeds, not game truths (see the honest summary); only Corpo Plaza has a measured seat. H10's seat roots, every window, the counters and the bed slots are unmeasured.
* The 2.5 sector data could not be parsed; the furniture was read on 2.31.
* The scene marker world transforms were not found; Corpo Plaza's origin is a fit good to about 0.5 m.
* Whether the shipped game ever sets the purchase facts by a path other than buying.
* Facts as the per-save store are unproven live; that is the first check.
* Role removal for the release (check 5).
* Convai concurrency and the shared key's day cap decide how lively the flat can be.
* The speak-up branch and the outfits branch are unfinished; the interfaces above are what this design needs from them.

## Owner's decisions (2026-10-25)

1. Persistence in saved quest facts; qualify first (live check 1), fall back to the session file (`runtime/housemates.json`, `registry.mode = 'file'`, the service's `storeMode`) if facts do not survive a load.
2. Built on top of `feat/immersive-invitations` (visiting copies and `joinVisitor`), rebased onto its latest commits; expect one more rebase at merge time. Outfits are used behind a guard (`convaiOutfitApi`), so housemates work without that branch.
3. Rest in another flat: she asks first (built, "Party transitions").
4. No cap on bodies, no rotation.
5. Chat only while V is in the flat, a pause of about 2 minutes after a chat, every provider alike, no Convai share, 8 lines per chat, one at a time.
6. Chat follows the Companion speak-up level (Off means none).
7. The recorder may run on a throwaway copy of a save (teleport and purchase facts); the game is not launched by the agent: "Live test, step by step" has the exact commands.
8. Move out row in the manager (built; MCM and Native Settings UI share the page), strings in all 15 locales.
9. Scope as designed (no Dogtown, no romance partners' places, no quest penthouses).
10. Shower out.
11. Greeting when V comes home after a long absence (built: one housemate, once per return, after at least 6 game hours away, from the housemate nearest V).

## What was built

| Part | File |
| --- | --- |
| Registry in saved facts, fallback file store | `mod/housemate-registry.lua` |
| Plan: day and night, bedtimes, assignment, next place | `mod/housemate-plan.lua` |
| Controller: zone, materialization, routine, held mode, offers, actions, party transitions | `mod/housemates.lua` |
| Game adapter: seat snapping with raycasts, workspot play and exit, walking, procedural places, bodies | `mod/housemate-world.lua` |
| Glue for init.lua | `mod/housemate-service.lua` |
| Pair chat scheduler | `mod/housemate-chat.lua` |
| Flats, spots, reserved facts | `mod/housemate-spots-data.lua` |
| Development recorder | `mod/housemate-survey.lua` (probe command `housemate`) |
| Visiting copies of the housemates, release to home, step, face, show/hide | `mod/companions.lua` (`owner = 'housemates'`, `home`, `releaseToHome`, `partyMemberOf`, `residentNpc`, `visitorStep`, `visitorFace`, `residentVisible`) |
| Quiet resident job without preparation | `mod/manager-party.lua` (`extra.resident`; residents are not party copies in `Q.list` and `Q.count`) |
| The housing offer in the lease | `mod/gameplay-actions.lua` (`homeOffer`, `groupHomeOffer`, `queueHome`, leave offers up to 12) |
| Wiring | `mod/init.lua` (tick, reset, offers, talk and seat hooks, `house` reaction line, district event), `mod/phone-chat.lua`, `mod/companion-seating.lua` (`onSettled`), `mod/companion-adoption.lua` (12 members), `mod/manager-ui.lua` (Move out), `mod/notices.lua` |
| Bridge | `bridge/companion-actions.mjs`, `protocol.mjs`, `text-actions.mjs`, `text-action-words.mjs`, `phone-chat.mjs`, `home-requests.mjs`, `house-chat.mjs`, `turn-context.mjs`, `battle-context.mjs`, `dynamic-info.mjs` |
| Archive components | `assets/gestures/gestures.json` (`bed`, `chairsleep`, `lean`, `sink`), `mod/gesture-catalog.lua`, `scripts/Build-GestureAssets.mjs` and `Verify-GestureAssets.mjs` (a sleep workspot that already repeats is accepted) |
| Facts | `scripts/Extract-ApartmentFacts.mjs` |

Differences from the design text above, found while building:

* The bed workspot `generic__lie_double_bed__sleep__01` exists for woman_base, man_base and man_fat only (no man_big): those bodies doze in a chair instead. The chair-sleep workspot exists for all four.
* The chair-sleep component serves chairs only (not counter stools), so a housemate dozes only in a chair.
* Beds ship with `usable = false` until the recorder measured their width and V's lying root (`housemate bed <id>`).
* Seats that may be V's own seat (`maybeV`) are held back until V's seat in that flat is known: the seating controller reports every seat V settles on (`onSettled`), the root is learned (`runtime/housemate-learned.json`, world coordinates, kept across saves) and a housemate on it gets up.
* The quest fact list was regenerated from the cooked quest phases (`scripts/Extract-ApartmentFacts.mjs`); the per-flat `mq055_02_<flat>_active` names are the real ones. `q001_in_v_room` is deliberately not reserved (nobody can be invited in the prologue and whether it is reset is unknown).
* The welcome line and the chat lines are `house` reactions (event `welcome` or `chat`) spoken like the meeting greeting; the chat speaker's text is captured through `convaiHouseReplyText` and handed to the next speaker.
* A talk with a housemate uses eyes and head only (like a character another mod spawned), so her workspot is never disturbed; the talk wakes a sleeper.
* The old per-flat `usable` seeds of Glen, Japantown and Northside stay off; those flats use the procedural standing places until the recorder measured them.

## Live test, step by step

Everything below is for a **throwaway copy of a save** (never one of the owner's saves). The commands go through the gesture probe:
`scripts\Send-HousemateProbe.ps1 <command>` (a wrapper of `scripts\Send-GestureProbe.ps1 "housemate <command>"`; Developer mode on; the game running and not paused). The steps below write each command as `housemate <command>` (with the wrapper leave the word `housemate` out); `help` lists them. Examples: `.\scripts\Send-HousemateProbe.ps1 where`, `.\scripts\Send-HousemateProbe.ps1 stay judy-alvarez corpo`.

1. **Facts survive a load (live check 1).** `housemate qualify write`, save the game, quit to the main menu, load that save, `housemate qualify read` must say `survived = true`. Load an OLDER save of the same character: `fact` must be 0 (the rollback). If facts do not survive: set `registry.mode = 'file'` and the service's `storeMode` to `'file'` (one line in `mod/init.lua`, `storeMode`), and say so.
2. **Own the flats.** `housemate own corpo`, `own glen`, `own japan`, `own north` (H10 is always yours); the manager's offer then lists them. `housemate reserved` in a flat prints the quest facts and their values (live check 9: nothing above 0 in a quiet save).
3. **Move somebody in without a conversation.** `housemate stay judy-alvarez corpo`, walk into the flat (or `housemate teleport corpo`): she appears and takes a place. `housemate status` shows the residents and the learned seats.
4. **Measure** (V stands or lies on the spot; one line each is appended to `runtime/housemate-survey.txt`, paste them into `mod/housemate-spots-data.lua`): `housemate record couch corpo-couch-3` on each seat (sit on V's own seat first: its root is learned too), `housemate bed h10-bed` lying in the bed, `housemate window h10-window` facing the window, `housemate door h10`, and `housemate scan 8` for a list of couch, chair, stool and bed candidates around V (`runtime/housemate-scan.json`). Repeat for all five flats.
5. **Conversation.** Talk to a party member inside a flat: "you can stay at my place" (the action), "rest" (released), "come along" to a housemate, "everyone, come with me" in a group, "you can't live here any more". In another flat: "rest" to a housemate whose home is elsewhere: she must ask first.
6. **Routine and sleep.** Wait or skip time to 23:00 to 02:00: housemates go to bed (a bed that fits two) or doze in a chair; talk to one: she wakes. Sit on the couch and sleep in the bed yourself: nobody sits on your seat, you can sleep.
7. **Chat.** `housemate chat` starts a pair chat at once (the 2-minute pause cleared): one conversation, 7 to 8 lines, each speaker in her own voice, then the pause. Talk to one mid-chat: it ends after the line in the air.
8. **Welcome.** Leave for 15 minutes of play (6 game hours), come back: one greets you. `housemate greet` forces it.
9. **FPS.** With everybody settled and with housemates registered but V elsewhere: the frame time must not change (the controller is a once-a-second step and nothing per frame).

## Owner's questions as they stood before the review (kept for the record)

1. **Persistence**: use the game's own saved facts for the housemate registry (recommended; the only per-save store that works in the shipped mod), or the file keyed by save line which falls back to the session (it forgets after a restart)?
2. **Merge order**: housemates builds on the visiting copies of `feat/immersive-invitations` and the outfit API of `feat/outfits`. Build after both merge, or carry the minimal visiting-copy part here?
3. **Releasing in the wrong flat**: she lives in Glen, V says "rest" in H10. Default in this design: she leaves and is home virtually. Alternative: she moves to H10. Which?
4. **A body cap per flat** (10, small flats 6) with the rest rotating "out": acceptable, or a different number?
5. **Pair chat on the shared Convai key**: the day's share of 8 percent is about one chat a day at a 100 turn cap. Raise it, or let chat run only on Mistral, Local AI and a player's own key?
6. **Pair chat setting**: reuse the Companion speak-up level (no new row, recommended), or give chat its own switch?
7. **Phase 0 measurements**: may an agent teleport V on a throwaway save and set the four purchase facts there to record Glen, Japantown and Northside (and H10 and Corpo Plaza), or will you do the survey in your own saves?
8. **Manager Move out row** in phase 2, or only the conversation action?
9. **Scope**: the Dogtown safehouse, Judy's/Kerry's/Panam's/River's places and quest penthouses are out. Anything to add?
10. **Shower**: leave it out until a generic pose exists (this design), or spend phase 3 time on trying the named-character poses on other bodies?
11. **Greeting** when V comes home (a short line from a housemate on the first entry after a long absence): wanted in phase 3, or never?
