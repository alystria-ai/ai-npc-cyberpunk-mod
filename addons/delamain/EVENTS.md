# Delamain Cab add-on: events and facts

This is the contract between the CET side (`init.lua`), the bridge side (`bridge.mjs`) and the persona writer. Eval rides
(`addons/delamain/eval/*.json`) are built from this list: use these event names, these fact names and only these fact values.
Facts the game cannot supply are left out of a remark, never filled with a guess, and Delamain must not invent them.

Add-on id `delamain-cab`, speaker id `delamain`, profile key `addon-delamain-cab-delamain`, anchored to the cab V sits in
(`anchor = 'vehicle'`), joins group rounds (`group = true`), Mistral or the local AI only.

## How a ride looks to the add-on

The game runs a cab as a script state machine (`delamain_taxi_state`, 0 to 8). The add-on follows it from game callbacks, never by
polling.

| State | Name | Meaning | Speech |
|---:|---|---|---|
| 1 | Spawned | V called a cab (it drives to V) | none (V is not in the cab) |
| 2 | Parked | cab waiting at the curb | none |
| 3 | Ready | V sits in the cab; the game has played its own greeting; the destination map opens | `boarded` |
| 4 | Started | V confirmed a destination; the cab drives itself | `ride-start`, then `district-passed` |
| 5 | Arrived | the cab stopped at the destination; the fare is charged; the game plays its own farewell | `arrival` |
| 6 | Cancelled | autopilot aborted (V backed out of the map, the cab was damaged, or something interfered) | `ride-interrupted` only if V is still seated |
| 7 | Finished | the game's farewell scene is over | none |
| 8 | Freeroam | the cab leaves into traffic | none |

The game's own cab voice (about a dozen short lines: greetings for a first and a repeat ride, the arrival announcement, farewells,
"sit back and enjoy the views", "your wish is my command") always plays first. The add-on never speaks over it (main mod scene
and dialogue gate) and never repeats it: no "welcome aboard", no "we have arrived", no "thank you for riding with Delamain".
Delamain's remarks add something on top (the weather, the company, the hour, the view, a dry aside).

Talk (the player types to Delamain with the talk key) works whenever V is inside the cab, from Ready until V steps out.
Delamain also joins a group round with the companion.

## Remarks

Pacing (the main mod's two built-in settings, **Time between remarks**, default 10 s, and **Most remarks per fight**, default 30; about
20 s between remarks on the local AI): one remark at a time, only the strongest waits behind one in flight, and a reply that arrives
later than its `ttl` is dropped, never played late. The add-on makes at most four remarks per ride (below), so a ride is two to four spoken
lines. A remark that was not heard (V started typing, V stepped out) costs nothing.

The game's own cab voice (a quest scene, plus the subtitle lines it shows) never gets talked over, and no remark is lost to it. Every
remark asks the main mod to be patient (`patience`, the table below): while a game scene or a game subtitle line is on, the remark
waits instead of being dropped; when it is over it waits 1.2 s more and is then written and spoken, if the ride is still in a state
it fits (`relevant`). A remark already being written when the game's line begins is taken back and written again after it (twice at
most). With no game voice playing there is no wait at all. That is how `boarded`, and above all `arrival`, follow the game's greeting
and farewell. A line that has started plays on through such a scene (`playThrough`); a phone call, Johnny or a cinematic still stops it.
A remark is spoken only on the ride it was asked for, and only while V sits in the cab.

| Event | Priority | maxWords | ttl (s) | patience (s) | Fires when |
|---|---:|---:|---:|---:|---|
| `boarded` | 4 | 22 | 15 | 30 | state becomes Ready and V is seated. It is cancelled if V confirms a destination before it plays; if it already played, `ride-start` knows (`greeting = false`). |
| `ride-start` | 4 | 24 | 12 | 20 | state becomes Started (the destination is set, the cab starts moving). |
| `district-passed` | 3 | 18 | 8 | 12 | during the ride, the cab enters a different district than it started in, at least 25 s into the ride. At most one per ride. Needs the district hook; without it the event never fires. |
| `arrival` | 5 | 26 | 12 | 25 | state becomes Arrived and V is still seated. Dropped (unspoken) if V steps out first. |
| `ride-interrupted` | 4 | 22 | 10 | 20 | the game cancels the autopilot while V stays seated (cab damaged, hacked, or something else stopped it). |

Not made, on purpose: nothing is said when the cab is called (V is not in it), while the destination map is open and V has not
decided, or after V steps out. A crash or a police chase cannot be detected from a safe game callback, so there is no event
for them (the `wanted` fact appears in the common facts when the police are after V).

## Facts

All facts are plain data in `handle:remark(..., {facts = ...})`. The bridge module turns them into a prompt block, so the model
sees them as sentences. Types: `string`, `int`, `bool`; "optional" means the key is absent when unknown.

### Common facts (every remark)

| Fact | Type | Example | Notes |
|---|---|---|---|
| `rideNumber` | int | `2` | This game session, from 1. |
| `timeOfDay` | string | `"late evening"` | One of: `"dead of night"` (0-4), `"dawn"` (5-6), `"morning"` (7-10), `"midday"` (11-13), `"afternoon"` (14-16), `"evening"` (17-19), `"late evening"` (20-21), `"night"` (22-23). |
| `hour` | int | `21` | 0-23, the game clock. |
| `district` | string | `"Watson"` | The district the cab is in at the event: `Watson`, `Westbrook`, `City Center`, `Heywood`, `Santo Domingo`, `Pacifica`, `Dogtown`, `Badlands` (the game's own district names). Optional. |
| `area` | string | `"Little China"` | The sub-area, when the game knows one. Optional. |
| `weather` | string | `"heavy rain"` | `"light rain"` or `"heavy rain"` only. Absent means dry or unknown; do not claim a clear sky. Optional. |
| `companion` | string | `"Judy Alvarez"` | The main-mod companion following V (aboard or waiting to board). Optional. |
| `companionCount` | int | `1` | How many companions follow V. Optional (absent when 0). |
| `wanted` | int | `2` | The police heat stage, 1 to 5. Optional (absent when 0). |

### `boarded`

Common facts plus:

| Fact | Type | Example |
|---|---|---|
| `destinationChosen` | bool | `false` (always false: that is why Delamain speaks) |
| `firstRideThisSession` | bool | `true` |

Example: `{"rideNumber": 1, "timeOfDay": "evening", "hour": 18, "district": "Watson", "area": "Kabuki", "weather": "light rain",
"companion": "Judy Alvarez", "companionCount": 1, "destinationChosen": false, "firstRideThisSession": true}`

### `ride-start`

Common facts plus:

| Fact | Type | Example | Notes |
|---|---|---|---|
| `greeting` | bool | `true` | `true` when `boarded` did not play (Delamain has not spoken yet this ride, so this line may greet, briefly). `false`: he already did, do not greet again. |
| `destinationDistanceMeters` | int | `3200` | Straight-line distance from V to the chosen point. Optional. |
| `destinationDirection` | string | `"north-east"` | Compass direction from V to the point (north = up on the map). Optional. |
| `fare` | int | `150` | Eddies, as the game charges it. Optional. |
| `etaSeconds` | int | `95` | The autopilot's own estimate. Optional (often missing right at the start). |
| `destinationName` | string | | Only when the game gives the pin a real name. The game's cab destination is a free point on the map with a generic title, so this is normally absent. |

The destination's district is **not** known at the start (the game gives the point no name and no district, and the add-on has
no map data). Delamain may speak about distance, direction, fare and the weather, and may say he will find the way, but must not
name a destination, a district or a landmark for it.

Example: `{"rideNumber": 2, "timeOfDay": "night", "hour": 23, "district": "Heywood", "area": "The Glen", "weather": "heavy rain",
"greeting": false, "destinationDistanceMeters": 5400, "destinationDirection": "south-west", "fare": 300, "etaSeconds": 120}`

### `district-passed`

Common facts (`district`, `area` are where the cab is now) plus:

| Fact | Type | Example |
|---|---|---|
| `previousDistrict` | string | `"Watson"` (where the ride started) |
| `rideSeconds` | int | `41` |

### `arrival`

Common facts (`district`, `area` are the arrival point) plus:

| Fact | Type | Example | Notes |
|---|---|---|---|
| `rideSeconds` | int | `204` | |
| `rideMinutes` | int | `3` | Rounded, at least 1. |
| `fare` | int | `150` | The fare charged. Optional. |
| `startDistrict` | string | `"Watson"` | Where the ride began. Optional. |
| `districtsPassed` | string[] | `["Westbrook"]` | Districts entered during the ride, in order, at most 4. Optional. |

### `ride-interrupted`

Common facts plus `rideSeconds` (int), and `cause` (string: `"the autopilot stopped before the destination"`; the game does not say why).

## Talk and group turns (no event)

When V types to Delamain, or he answers in a group round, his prompt carries a "the ride right now" block built from the add-on
state: phase, minutes riding so far (computed when the turn is built), where it started, the distance and direction of the
destination, the weather, the time, who is aboard, and the fare. The persona must be able to answer "where are we?", "how long
now?", "how much is this costing me?" from that block, and say plainly what he does not know. Companions get a short note that
they are riding in a Delamain cab with V and that Delamain can hear them.

## What the bridge module sends (response quality)

- **Weather** goes only with the first two events of a ride (`boarded`, `ride-start`; a ride with no `boarded` sends it with
  `ride-start` and `district-passed`). Later remarks are told not to mention it; talk answers get it as "mention it only if V asks".
  The companion note drops it after the first two events too. The 8b model repeats every fact it is given.
- **Fare** goes with the ride start and talk, never with `arrival` (the persona says it once, at the start; repeating it at arrival
  was the main cause of dropped repeats). The `arrival` guidance does not ask for it.
- **Companion pronoun.** The bridge asks the main mod (`api.character(name)`) who the companion is and writes "Panam Palmer
  (she/her) rides with V". An unknown companion is sent with the name alone.
- **Ride log.** The module keeps up to six notes for the current ride in memory (what happened or what V said, and what Delamain
  answered, each at most 90 characters of speech) and sends the newest ones that fit 1,100 characters as "Earlier on this ride", so
  he can call back within the ride. It restarts when the ride number changes or after 30 minutes of silence. Never written to disk.
- **Talk length.** `persona.talkWords` is 25 (32 in the fragmented mode): answers to V are one or two short sentences, at most 25
  words, whatever the main mod's own limit says.
- **Quest ending.** The game stores which ending of *Don't Lose Your Mind* the player got (`sq025_delamain_fate`, values 1 to 3),
  but the repository's research does not say which value is which ending, so no fact or mode is sent and Delamain stays ambiguous
  (see the bible, section 4).

## Memories (the `remember` hook)

After an `arrival` or `ride-interrupted` line, the bridge keeps one sentence when the ride was notable (a companion aboard, three
minutes or more, rain at night, or interrupted). Example: `"Drove V and Judy Alvarez through the rain at night, Watson to Heywood,
3 minutes; Delamain said: ..."`. The persona may call back to these now and then.

## Settings

| Setting | Meaning |
|---|---|
| Time between remarks, Most remarks per fight (built in) | Pacing, as above. |
| Delamain speaks on rides | On or off (default on). Off disables remarks and talk. |

Delamain always joins a group round with the companion while V is in the cab.

## Ideas for eval rides

Build each ride as the event sequence above with real fact values; interleave `{"say": ...}` steps for talk.

1. Evening, light rain, Judy aboard: `boarded`, `ride-start`, V asks "Where are we?", `district-passed`, V jokes about the fare, `arrival`.
2. Night, dry, V alone, ride of 40 s: `ride-start` (`greeting: true`), `arrival`.
3. Heavy rain, companion Panam: `ride-start`, V tests him ("Are you the real Delamain?"), `ride-interrupted`.
4. Dead of night, wanted level 3: `ride-start` with `wanted`, V asks him to hurry.
5. Group round: a companion line, then Delamain's answer to it (the companion talks to Delamain about the car).
6. Two rides in a row (`rideNumber` 1 and 2): the second `boarded` must not repeat the first.
