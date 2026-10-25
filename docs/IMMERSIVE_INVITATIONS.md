# Immersive invitations (design)

Status: design for review, written 2026-10-25 on branch `feat/immersive-invitations`. Nothing is built yet. Everything below that
touches a game API says whether the mod already uses it (and where) or whether it is a guess that only a live run can settle (the list
is in "What only a live run can settle").

Origin: a player asked to be able to call or text a companion, ask her to meet V in the apartment, at a bar or at a waypoint, and have
her really travel there, arrive after some time, wait a while, and leave (remembering it) if V never shows. The owner's spec is
reproduced in "Requirements" so the design can be checked against it line by line.

## Requirements (owner, 2026-10-25)

1. A sub-page **Immersive invitations**, opened by a button in Settings, with many options. First option On/Off, **Off by default**.
   With it off, invitations behave exactly as today and nothing of this feature runs or is loaded.
2. Destination: V's current location by default. If V had set a waypoint on the map before asking, she goes to the waypoint and says so.
   She is told where that is (district, sub-district, nearest named landmark or venue if the game exposes one) so she can answer like
   she knows the place.
3. Arrival method, default **Walk**: she is spawned out of V's sight, beyond a minimum distance, on walkable ground, and walks. **Car**:
   when a road is near she is spawned farther away in a car and drives to the spot, never putting the car on the curb: she stops on the
   road near the destination, gets out and walks the rest. That car becomes **her car**: later V can ask her to drive him somewhere in
   it (extend the chauffeur code), and her car persists across saves until she leaves or is dismissed.
4. Arrival time (real minutes): **Right now** (default), 2, 5 or 10. A timed arrival is timed so she arrives at that moment.
5. On arrival she texts V (the mod's phone path) to say she is there.
6. She waits as long as she took to arrive (2, 5 or 10 minutes). For Right now there is a separate option **How long she waits**
   (2, 5, 10). If V does not come she leaves, sends an angry text and **remembers being stood up**, so she can bring it up next time.
7. The conversation stays simple ("come meet me", "come to the waypoint"); the many cases live in the options.
8. The existing invitation flow (phone Chat, holocall, talk) and the manager's Invite button route through this system when it is on.
9. Edge cases to design: stuck or very far pathing, interiors/elevators/no navmesh, no road for Car, V in a scene/combat/call/vehicle at
   arrival, V fast travels away, save/load mid-trip, "never mind", several companions at once, a companion already in the party, who
   may be invited today (game-placed story characters get talk only, only the mod's own copies are spawned).
10. FPS first, response latency as important, unload what is unused, `ui.t` strings with all 15 locales, both game versions, no per-frame
    teleports (movement through AI commands).

## What exists today (so the design reuses it)

| Piece | Where | What the design takes from it |
| --- | --- | --- |
| Invite queue: reservation, memory/voice/connection preparation, `gate`, notice board | `mod/manager-party.lua` (`Q.invite(key, extra)`, `extra.gate`, `extra.quiet`), `mod/invitation-readiness.lua`, `bridge/companion-invitations.mjs` | An appointment becomes one queued job whose `gate` holds the spawn until the appointment says "now". Preparation, the connection slot and "Cancel invitation" are already solved. |
| Copy creation | `mod/companions.lua` `spawnCopy` (DynamicEntitySpec, tag `CyberpunkConvaiCompanion`, `persistState/persistSpawn=false`), `attachFollower` | One new spawn option: a position other than V's side, and a new entry state `visiting` (no follower role yet). |
| Placement checks | `mod/companion-placement.lua` (`find`, `verify`), `mod/companion-clearance.lua`, shared per-update spatial budget (`deferred`) | Spot finder for the hidden spawn point, with the same budget and the same "retry later" convention. |
| Out-of-sight test | `companions.lua` `hiddenFromPlayer` (camera forward angle beyond the field of view, else a line-of-sight ray) | The "a direction V is not looking" rule. |
| Walking | `mod/companion-actuator.lua` `board(s, destination, {navigate=true, gait})` (native `AIMoveToCommand`, with `sense`/feedback, stuck guards) | The only movement primitive for a visitor. No teleports. |
| A non-party mover | `mod/companion-adoption.lua` departure (`A.owns`, `A.decide`), used by `companions.update` | Precedent: another module owns a copy's movement. Also gives the walk-away and out-of-view removal for the stood-up exit. |
| Driving | `mod/companion-vehicle-native.lua` (`spawn`, `mount`, `follow`, `brake`, `destroy`, tag `CyberpunkConvaiPartyVehicle`), `mod/companion-chauffeur-native.lua` (`AIVehicleDriveToPointAutonomousCommand`, AutoDrive destination getters), `mod/companion-vehicle-catalog.lua` (a personal car per character, fallback Hella) | Spawn her car, put her in the driver seat, drive to a road point, brake, get out. |
| Phone | `mod/phone-chat.lua` (`append(contact, text, sent)`, request/response files `runtime/phone-chat-input.json`, `phone-chat-output.json`), `bridge/phone-chat.mjs` | Proactive texts are phone turns with no typed line; the received bubble is added with `append`. |
| Turn context | `mod/turn-context.lua`, `bridge/turn-context.mjs`, `bridge/place-names.mjs` | District, sub-district and the named-venue table; the carrier for "you agreed to meet V at ..." and "V stood you up". |
| Memory | local routes `bridge/memory-store.mjs` (`record({profileKey, channel, v, r})`), Convai's provider memory, per-character `runtime/` files | The stood-up memory hook. |
| Settings | `mod/manager.lua` (settings table, publish pattern, e.g. `dynamicInfo`), `mod/manager-ui.lua` (sub-pages, e.g. `dynamic-info`) | The sub-page and its saved values. |
| Save identity | `mod/phone-chat.lua` `binding()`/`bindingKey()`, `mod/save-identity.lua` (campaign, branch, ledger sequence) | Keying persisted appointments to a save line. |

Not available and not invented: the game has no call that returns the district or a venue for an arbitrary world position, and no road
graph query (checked in the installed scripts, `tools/redmod/scripts`). The design works around both, see "Where is that place" and
"Car arrival".

## Settings page

A button row **Immersive invitations** (value "Open") in Settings > Companion behavior, same pattern as Dynamic info (view
`immersive-invitations`, Back goes to Settings). Saved in `settings.immersiveInvitations`, published once to a global table (like
`convaiDynamicInfo`) so nothing reads the file again. A missing or malformed value is the default.

| Row | Values | Default | Saved key | Notes |
| --- | --- | --- | --- | --- |
| Immersive invitations | Off, On | Off | `enabled` | The master switch. |
| How she arrives | Walk, Car | Walk | `arrival` | Car falls back to Walk with no road or no car (one log line, no player message). |
| When she arrives | Right now, In 2 minutes, In 5 minutes, In 10 minutes | Right now | `delay` (0, 2, 5, 10) | Real minutes. |
| How long she waits | 2 minutes, 5 minutes, 10 minutes | 5 minutes | `wait` | Used when she arrives Right now. For a timed arrival she waits as long as the delay (the owner's rule). The help says so. |
| Go to my waypoint when one is set | Off, On | On | `useWaypoint` | Proposed. Off = always V's current place. |
| She texts you | Off, On | On | `texts` | Proposed. Arrival and stood-up texts (the memory still works with texts off). |

More rows are cheap to add later (the page is a list). Not proposed now: a map marker for the meeting spot (needs a mappin write API
the mod does not use yet).

Strings: every label, help text, notice and fallback text through `ui.t` with an entry in each of the 15 `mod/locales/*.lua`
(`cs de es fr hu it ja ko pl pt-br ru tr uk zh-cn zh-tw`), and `scripts/Extract-UiCatalog.mjs --check` stays green. Translation is
mechanical work for Haiku with the English source and an existing locale as the example.

With the master switch Off: `mod/immersive-invitations.lua` is not even loaded (the module is `dofile`d lazily on the first On), the
offers described below are never made, the manager's Invite and the phone's J key take the old path. Turning it Off while an
appointment exists cancels every appointment quietly (see "Edge cases") and drops the module's tables.

## How the player asks

The conversation stays simple. The game, not the player, decides the destination and sends it with the offer.

### Channels

| Channel | Who is asked | How the request reaches the game |
| --- | --- | --- |
| Phone Chat (text) | Any phone contact the mod can invite and who is not in the party | New: the pending phone request carries a **meet offer**; the reply may carry a **meet action** (below). |
| Holocall (voice or text) | Same | New: `mod/holocall.lua` turns carry the offer; today `init.lua` skips gameplay actions in a call. |
| In-person talk | A **waiting visitor** (she is standing at the spot) | Nothing new: she is a managed copy, so talk works. Her turn context says she is waiting for V. |
| Contacts tab J key, manager **Invite** | The character chosen | Not a conversation: the same appointment is created with the page's defaults (destination rule below). |

Today no conversation channel can invite someone: "follow" for world characters is retired (`docs/WORLD_COMPANIONS.md`) and phone
Chat/holocall carry no actions. So the meet action is new, but it reuses the established pattern: the game builds an offer, the
bridge advertises it to the character, the character's own answer decides, the game validates the answer against what it offered and
nothing else.

### The meet offer (game to bridge)

Built by `mod/immersive-invitations.lua` when a phone or call turn is sent for a contact who may be invited today. Fields: a one-use
`token` bound to the request, `kind` (`here` or `waypoint`; both when a waypoint is set), the **place** words (below), `etaMinutes`
(0 when Right now), `waitMinutes`, and for an unavailable offer only a reason code so the character can decline in character.
Reason codes: `already-here` (in the party), `pending` (already on her way, so the character can say so and offer to cancel),
`combat` (V is in a fight), `no-world`, `unavailable` (cannot be invited today, never offered). When there is a pending appointment
with this character the offer also carries `cancel` so "never mind" is possible.

Coordinates, entity ids and seats never come from the model. The model only picks `meet-here`, `meet-waypoint` or `cancel-meet`
(or none). Convai: named actions in the existing `action_config` context update (`Meet V Here <token>`, `Meet V At Waypoint <token>`,
`Cancel Meeting <token>`), `bridge/companion-actions.mjs`. Mistral, Local AI and Custom: the existing decision step
(`bridge/text-actions.mjs`) gains the codes `meet`, `meet-waypoint`, `cancel-meet`, with a screen in `bridge/text-action-words.mjs`
for the languages the game ships (the same stems approach: "come", "meet", "wait for me", "see you at", "come over", "I'm at").
The prompt wording follows the established rule: only a clear request counts, "let's meet sometime" and "I'll see you around" do not,
and the character never claims an arrival time the offer does not give.

Default rule when both kinds are offered: a clear "here/where I am/my place" means `here`; anything else ("come meet me", "come to
the waypoint", "meet me there") means the waypoint. This keeps the sentence simple and gives the owner's rule (waypoint wins) while a
stale pin cannot override a clear "here".

### Validation (game side)

The lease is the pending request itself (phone) or the call turn (holocall): the answer must carry the offered `token`, the same
profile key, the same world token and generation (`mod/gameplay-actions.lua` already does this for entity actions; the phone and call
variants are keyed by contact instead of entity). One answer per request. A revoked or late answer does nothing, the character's text
stays a promise she did not keep, and a debug line says why. The destination is frozen at the moment the request was sent (what the
offer said), not re-read when the answer arrives.

### Who may be invited

Exactly today's rule, nothing wider: a profile for which `companions.definition(key)` exists, `profile.invite ~= false`, not a
game-placed story character (they get talk only; the mod spawns its own copy only through the manager rules that exist today), not
already in the party or already pending. A character with no phone contact cannot be reached by phone or call but can still be invited
from the manager.

## Where is that place

Both the character's reply and the arrival texts need a place. The data, in order of trust:

1. **V's current location**: `currentDistrict()` in `mod/init.lua` (PreventionSystem current district record: root district and the
   most specific record, for example `Kabuki_LizziesBar`), `indoors` from `mod/turn-context.lua`, worded by `bridge/place-names.mjs`
   `describePlace` ("Lizzie's Bar, Kabuki, Watson", "V's apartment in Megabuilding H10", a plain neighbourhood). This is exact for
   the table of named interiors and homes already in `place-names.mjs`. Outdoors it is district and sub-district only: the game has
   no "nearest shop" query.
2. **The nearest named landmark** (new, optional): `FastTravelSystem.GetFastTravelPoints()` rows give `GetPointDisplayName()` and
   `GetDistrictDisplayName()` (installed `fastTravelSystem.script`); a row's world position comes from its mappin
   (`Game.GetMappinSystem():GetMappin(id):GetWorldPosition()`, the call `companion-chauffeur-native.lua` already uses for the pin). The
   nearest point within about 250 m gives "near {point name}". Whether undiscovered points are listed and expose a position is
   unproven (live list).
3. **The waypoint**: the tracked destination is `PlayerTracked` in `auto:GetAutodriveDestinationType()`; its pin position and road
   endpoint are read exactly as `waypoint()` in `companion-chauffeur-native.lua` does (that code already requires a player-tracked
   pin and never takes a quest marker as the waypoint, which stays the rule here). The pin's own display name is used when the game
   gives one. The game cannot say which district a map point lies in, so the district words come from item 2 when a fast travel point
   is close, from V's district when the waypoint is within about 150 m of V, and otherwise from geometry that is always available:
   "about 1.4 km north-east of {V's district}". The character is told which of these it is, so she never invents a name.
4. A shipped coarse gazetteer (hand-made district centres) is possible if items 2 and 3 prove too thin. It needs the owner's call
   (open question 5).

The place words travel as plain text (length-limited, no markup) in the offer, the appointment record and the texts' prompts. They are
words for the model, never parsed back by the game.

## The appointment

One record per (profile key). A second request for the same character while one is pending replaces it quietly (new destination, old
one cancelled). Created when the validated meet action arrives, or by the manager/J key.

```
id, profileKey, key (definition key), name
saveKey            save line (campaign + branch, see Persistence) or nil when the save identity is unavailable
createdSeq         save ledger sequence at creation, or nil
dest               {x,y,z, floor info, kind='here'|'waypoint', place={text, source}, road={x,y,z,pathLength}|nil}
method             'walk' | 'car'  (the setting at ask time, after fallback)
etaSeconds         0 for Right now, else 120/300/600
waitSeconds        2/5/10 minutes
phase              see the state machine
tArrive            target arrival, in module seconds (below)
tWaitEnd           when waiting started + waitSeconds
serial             companions entry serial once spawned (visitor)
carId              her car record id once she has one
held               nil | 'combat' | 'scene' | 'call' | 'menu'   (see Edge cases)
stuck, retries, spawnTries
```

### Clock

"Real minutes" means the player's real time spent in the world, not game time (the game clock runs fast and slows in bullet time).
The module keeps one `clock` that adds the frame delta, and that is **frozen** while the world is not running (a load screen, the
main menu, a paused game). Rationale: V opening the manager for three minutes must not make her give up, and an appointment must
not expire while the game is closed. If the owner wants wall-clock time instead (menu time counts) it is one line (open question 4).
The saved form is remaining seconds, not an absolute time, so a reload cannot misjudge it.

### State machine

```
            ask validated / Invite
                   |
                   v
             +-----------+   feature Off, never mind, replaced, V dismisses her
             | scheduled |-----------------------------------------------+
             +-----------+                                               |
                   | clock >= tSpawn  (tSpawn = tArrive - tripEstimate,    |
                   |                    "Right now": immediately)          |
                   v                                                       |
             +-----------+  preparation failed -> failed (sorry text)      |
             | preparing |  (manager-party job: memory, voice, connection) |
             +-----------+                                                 |
                   | job ready and a spawn spot found                      |
                   v                                                       v
             +-----------+  V far from the spot (> SIM_RADIUS):        +-----------+
             | en-route  |--- entity not simulated, "virtual" ------>  | cancelled |
             +-----------+  V near: entity walks / drives              +-----------+
                   | physically arrived, or tArrive passed while virtual
                   v
             +-----------+  (car: arriving = stop on road, get out, walk the rest)
             |  waiting  |--- V within MEET_RADIUS for MEET_DWELL ---> met  (she joins the party)
             +-----------+
                   | clock >= tWaitEnd and V not met and not held
                   v
             +-----------+
             |   left    |  angry text, ledger entry "stood-up", visible exit or quiet removal
             +-----------+
```

Terminal states are `met`, `left`, `cancelled`, `failed`. After a terminal state the record is removed from the live table (the ledger
keeps the stood-up and met facts for the memory hook, bounded). A text is sent at most once per transition and is recorded on the
appointment before sending so a reload cannot repeat it.

`tripEstimate`: walk = path length / assumed speed, car = road distance / assumed speed plus the walk from the road. Assumed speeds
(walk about 1.5 m/s, run about 4 m/s, car about 12 m/s on the AutoDrive-style command) are named constants to calibrate live. If she
is behind schedule she runs (gait `Run`, the actuator's existing choice for gaps over 3 m).

### Virtual and materialized

A key idea that gives fast travel, save/load and FPS for free: **the entity exists only while V can plausibly see or reach it.**
Until `en-route`, and whenever V is farther than `SIM_RADIUS` (250 m, a constant) from the destination, the appointment is data and
two numbers. Nothing is spawned, nothing ticks except one clock comparison at 1 Hz.

* V near the spot while she is due: the entity is spawned out of sight at the distance that fits the time she has left, then walks
  or drives in. This is the case the owner pictures.
* V far from the spot when she is due: no entity. At `tArrive` the arrival text is sent (the text is how V learns she is there) and
  the wait clock starts. If V comes within the radius while she waits, she is **materialized standing at the spot** (the same spawn
  code with the spot as the position), so V never sees her pop in: V is by definition arriving from outside her sight, or the spawn
  is placed where V cannot see (same out-of-sight rule).
* V fast travels: `companions.beginFastTravel` today captures every `ready`/`spawning` copy and re-places it beside V. A visitor must
  not be carried, so the module deletes any materialized visitor first (new hook, one call at the top of `beginFastTravel`, entries in
  state `visiting` are skipped by the existing capture, which only takes `spawning`, `ready` and `transit`) and the appointment goes
  virtual. "She still goes to the spot" holds.

## Spawn and movement

### Visitor entries

A visitor is an ordinary `companions` entry created through the normal job (`Q.invite` -> `companions.spawn`) with two differences, both
inside `mod/companions.lua`:

* `spawnCopy` takes `invitation.appointment = {position, yaw}` and uses it instead of `formationPosition(player, lane)` plus the
  placement search around V (the hidden spot already passed the same clearance and ground checks).
* `attachFollower` ends with `entry.state = 'visiting'` instead of `'ready'` and does **not** set the `AIFollowerRole`. Every
  existing loop keys on `state == 'ready'` (formation, fleet, recovery, tactics, gestures, seating), so a visiting entry is already
  ignored by all of them. It still counts for `occupiedPositions`, deletion, failure cleanup, reload cleanup and Dismiss (any state).
  New: `companions.visitors()` lists them with their `npc` and `motor`, and `companions.joinVisitor(serial)` finishes
  `attachFollower` (sets the follower role, `state = 'ready'`), so she becomes a normal party member **without respawning** and
  without a visible swap.

The module drives a visitor only through `companion-actuator.lua`: `sense` every module step, `board(..., {navigate=true, gait})` to
walk, `stay` to hold. No teleport is ever sent by this feature (the actuator's own recovery teleports are for party members and are
not reachable from a visiting entry).

### Hidden walk spot (Walk)

`spotFinder` runs in the spatial budget the placement code already shares (a `deferred` answer means "try on a later step", never an
error). It generates candidates on rings around the destination at distances 90, 70, 50, 35, 25 m (interior floors: 25, 15, 10 m,
and a lower minimum), twelve bearings each starting from the bearing **behind V's camera** so the first hit is usually the direction
V is not looking. A candidate is accepted when all of these hold:

1. walkable ground: `Game.GetAINavigationSystem():FindPointInSphereForCharacter` returns `OK` within 0.55 m, as `placement.find`;
2. a real route to the destination: `CalculatePathForCharacter(candidate, destination)` exists, its length is at most 1.35 times the
   straight distance plus 6 m and at most 160 m, and every point is within 0.9 m of the destination's floor (the checks
   `placement.find` uses, here at long range);
3. not seen: `hiddenFromPlayer(player, candidate)` is true (outside the view angle, or no line of sight) at the moment of spawning and
   the whole first 15 m of the route is also out of sight when that can be afforded, otherwise only the spawn point;
4. at least `MIN_DISTANCE` from V (35 m outdoors, 12 m inside) and clear for her body (`clearance.body`);
5. different from other pending spawns (several companions never share a spot).

If nothing fits at long range the minimum distance shrinks in steps and the visibility rule relaxes last ("behind V's back, farther
than 8 m"). If still nothing fits after the tries the appointment falls back to **appear near, walk up** (spawn out of sight at the
nearest point that passes 1, 2 and 4; if even that fails the appointment fails with the sorry text, see Edge cases).

### Car arrival

Requested when the setting is Car, the character drives (`companion-vehicle-catalog.lua` `drives()`; Alt Cunningham never does) and
the cap of simultaneously driving visitors (3) is not reached. Otherwise Walk, with a log line.

* **Road end point R** (where the car stops):
  * destination = V's place: `Game.GetScriptableSystemsContainer()` -> `PreventionSpawnSystem:GetNearestRoadFromPlayerInfo()` gives
    `{point, pathLength}` (the installed `preventionSpawnSystem.script`; the game's own police fallback uses it). Accept when
    `pathLength` is at most 60 m. The point is read at ask time and stored.
  * destination = waypoint: the AutoDrive destination getter's road endpoint (`GetAutodriveDestination`) read at ask time, exactly as
    the chauffeur does. The sidewalk spot is the pin; the road end point is where the car goes.
  * No R: Walk.
* **Car spawn point S**, 150 to 300 m from R. The game has no road graph query, so candidates come from three sources and each is
  verified by the car itself:
  1. **breadcrumbs**: while the setting is Car, V's own driving leaves a ring of at most 40 road positions (one per 30 m of travel,
     sampled on the existing tick only while V is mounted and moving); one inside the 150 to 300 m band of R is the first choice;
  2. points along the AutoDrive route and the pin's road end point, offset along the road direction;
  3. ring candidates around R.
  Each candidate passes the existing vehicle footprint test (`companion-vehicle-native.lua` `spawnPoint`: a level 3.6 x 7.6 m
  footprint, a body volume overlap check) and the hidden-from-V test, then the car is created (`DynamicEntitySpec` as
  `M.spawn` does, **with its own tag** `CyberpunkConvaiHerVehicle` so the party-car sweep never deletes it, and reload cleanup gets a
  matching receipt). After attachment the car must answer `IsInTrafficLane()` (a scriptable getter on `VehicleObject`) within 1.5 s or the candidate
  is rejected, the car deleted, and the next one tried (at most four, spread over steps, only at the moment of spawning).
  No verified road within the tries: Walk.
* **Driver**: the visitor is created at S in the driver seat. Whether `spec` allows spawning mounted, or `AIMountCommand` with
  `isInstant=true` right after attachment (the failsafe path `companion-vehicle-native.lua` `M.mount` already has) is a live check;
  both are invisible because S is out of sight.
* **Drive**: `AIVehicleDriveToPointAutonomousCommand` to R, with the production flags the chauffeur uses (max speed 8 m/s there; this
  feature starts at 12 m/s and the value is a constant to tune, traffic clearing off, `needDriver` on, `minimumDistanceToTarget`
  6 m so the car stops on the road and not at the curb). One command, the exact handle kept for cancel or retirement (the chauffeur's
  receipt rules). The update path (`AIDriveToPointAutonomousUpdate`) is not needed: the destination is fixed.
* **Stop and get out**: the command ends (`Success`) or the car is within 14 m of R and slower than 0.5 m/s: `ForceBrakesUntilStoppedOrFor`
  (`M.brake`), then `AIUnmountCommand` through `M.mount(entry, vehicle, seat, true)` with the bounded retry the party exit uses.
  A stop that is not on a road (`IsInTrafficLane()` false and farther than 14 m from R) counts as a stuck car (below).
* **Walk the last leg**: from the car door to the destination: the same walk as Walk, using the nearest hidden-spot logic only for the
  start. If no route exists from the road to the spot (a gated yard, an interior) she stands by the car and the text says where
  ("I'm at the kerb outside"). The appointment still moves to waiting.
* **After**: the car stays where it stopped and is registered as **her car** (below).

### Staying honest about time

Both methods compute `tSpawn` from the estimate and re-check at each step: late by more than 20 s means run, early means she slows
to a Walk for the last 20 m. A hard trip cap of `max(90 s, 2 x estimate)` ends the trip (stuck handling).

### Stuck, very far, no route

Progress is checked at 0.5 Hz (a cheap distance-to-goal comparison, not a path query). No progress of 1.5 m in 8 s:

1. first the actuator's own recovery runs (it already handles obstacles, doors, stairs for party members; for a visitor its
   `guardMotion` is called by the module step);
2. second stall: re-issue the walk once to the goal;
3. third stall, or the trip cap: **re-spawn close**: delete the visitor (out of sight) and spawn again 15 to 30 m from the destination
   on the best candidate (the spot finder with a short distance band). Maximum two re-spawns;
4. nothing works: she is placed by the "appear near" rule, or the appointment fails with the sorry text.

A car that does not move for 15 s with a command running, or cannot find a route (the command ends `Failure`), is deleted (out of
sight) and replaced by a walk visitor from a close spot: Car degrades to Walk, one log line.

## Arrival, waiting, meeting

### Arrival text

Sent when she physically arrives (a walking visitor within 3 m of the destination, or a car visitor that has left the car and stopped
walking), or at `tArrive` when virtual. If the player's texts switch is off nothing is sent (the state still advances). The text is
**generated by the character** with a proactive phone turn: the phone request has no typed line and carries an `event`
(`arrived`, with the place words, and for a car arrival that she is "by the road"); the bridge answers with one short text that fits
her voice and the provider. The received bubble is added to the phone history with `phone-chat.lua` `append(contact, text, false)` and the
usual notice is posted. If the provider cannot answer in 20 s (daily limit, no connection, a local model off), a plain localized
`ui.t` text is used, so the arrival is never silent. Latency is not on V's critical path: V is not waiting for it.

### While V is busy

`held` is set while V is in combat, a scene or dialogue, a vehicle that is moving, a holocall or a menu: the arrival text is queued
until none of them holds (the text appears in the phone history at once, the popup waits), the wait clock does not run, and the stood
up decision cannot fire. She waits quietly. The checks use values the mod already reads (`player:IsInCombat()`, the scene helpers
`mod/gameplay-actions.lua` and the chauffeur sample use, the holocall state, the pause state), once per step.

### Meeting

While `waiting`, once per step: V within `MEET_RADIUS` (5 m, same floor within 3 m) for `MEET_DWELL` (1.5 s), or V opens a talk with
her (the talk path knows her as a managed copy). V in a stopped vehicle within 10 m counts. Then `companions.joinVisitor(serial)`
makes her a normal party member (formation, car boarding, everything as for any invited copy) and the board posts one notice. She
speaks once through the existing automatic-reply path only if that path is available without an extra request; otherwise she is just
there and the first talk is normal. (Open question 1: whether meeting should join the party at all, or leave her standing as a
visitor until V says "come with me". The default here is that meeting = joined, which matches "meet us".)

### Stood up

At `tWaitEnd` (and not held, and V not met):

1. the angry text, generated like the arrival text (event `stood-up`, with the place and how long she waited), with a localized
   template fallback;
2. the memory (next section);
3. the exit: if the entity exists and V can see it, the existing departure walk (`companion-adoption.lua`: walk away, removed once V has
   not seen her for 1 s or she is 50 m away); if she came in a car and the car is in view, the car stays until out of view and is then
   deleted; if V is not near, nothing is spawned or simulated at all (a virtual appointment just ends);
4. her car record, if any, is deleted with her.

## Her car

* **Registry**: when a car visitor gets out, the car becomes `cars[profileKey] = {record, appearance, name, parked = {x,y,z,yaw},
  place text, saveKey, createdAt}` (one car per character). The entity keeps the tag `CyberpunkConvaiHerVehicle`.
* **Lifetime**: until she leaves or V dismisses her (dismiss deletes the record and the entity once nobody is in it, out of view,
  using the same deletion proofs as the party cars: own creation receipt, managed flag, tag, no occupants, no player). Open question 6:
  whether an unused car should also expire after some days.
* **Materialization**: like appointments, a car is data until V is within about 200 m of where it is parked. Then it is spawned
  parked, rotated as it was, and despawned (or left, if she is in it) when V goes beyond 400 m. After a load the registry restores it
  the same way. It is never spawned on top of something: the footprint test of `spawnPoint` runs at its parked pose; if blocked it
  nudges along the road within a few metres, else waits.
* **Drive me**: the chauffeur's offer gains a second car source. Today `sample()` takes the summon blackboard or the one nearby
  owned car, and `liveCar`, `ownedCar` and `offer` all require `IsPlayerVehicle()`; her car is a mod-spawned vehicle and may not
  answer that way (a live check). Extension: a car source `her-car` whose validity is "managed, tagged `CyberpunkConvaiHerVehicle`,
  the registered record, belongs to this character", used when this companion has a registered car within 25 m of V (the same bound
  as the player-car rule is 20 m) and V has no better source (V's own car beside her wins if V stands next to it; the offer says
  which one and the character may mention it). Everything after the car is chosen is the existing chauffeur: she takes the driver
  seat, V enters a passenger seat, the trip runs, the same cancel and interruption rules. If her car is farther than 25 m the offer
  is unavailable with a new reason code (`her-car-distant`) and the text-route character can say where she left it (the registry's
  place text). Fetching the car to V is a possible later step, not part of the first build.
* **Passenger-only** (Alt Cunningham) never gets a car; **Johnny and others with a personal car** use the catalog car
  (`preferred`), everyone else the fallback.

## Persistence and save/load

State file `runtime/immersive-invitations.json` (player state: restored under Mod Organizer 2 by the same mechanism as the other
`runtime/` files, `bridge/game-state.mjs` copies it; add it to that list), versioned, atomic write, written on transitions and every 30 s of
module time while an appointment is live, at the end of a session (`abandon`), never per frame. Layout:

```
{version:1, saves:{ "<saveKey>": {appointments:[...], cars:[...], ledger:[...]} }}
```

* **saveKey**: the campaign/branch scope the phone chat already derives from `save-identity` (`phone-v1:<user>:<campaign>:<branch>`).
  When the identity is unavailable (`status = 'unavailable'`, session-only) appointments are kept in memory only and a load drops them
  silently as `cancelled`.
* **Timeline check**: each record stores the save's ledger sequence at creation. Loading an earlier save of the same branch (sequence
  lower than the record's) drops that record: it never happened in this timeline.
* **CET reload** (no world change): appointments are restored from the file at init; entities that existed before the reload carry
  the companion/vehicle tags and are swept by the existing reload cleanup (extended with the new car tag), then the appointment
  materializes again by its rules.
* **Load**: scheduled: resumes with its remaining seconds. En-route: becomes waiting-virtual if the remaining trip is under 30 s, else
  scheduled with the remaining time (she is "still on the way"). Waiting: stays waiting with the remaining wait; materializes when V
  is near the spot. A wait that would have ended resolves only through play time, never by the clock of a closed game.
  Nothing is restored for a different save line.
* **Game version**: the file carries nothing version specific.

## Memory: being stood up

Three layers, so it works on every provider:

1. **The text itself**: the angry message is in the phone history, and phone turns already receive the last six rows of the
   conversation (`recentConversation`).
2. **Dynamic context** (all channels: talk, group, phone, holocall): the ledger entry `{kind:'stood-up', place, waitedMinutes,
   at}` is sent in `turnContext.appointment` (new bounded field in `mod/turn-context.lua`, parsed and worded in
   `bridge/turn-context.mjs`: "V arranged to meet you at {place} and never came. You waited {n} minutes and left, angry. Bring it
   up in your own way if it fits, do not recite this."). It is attached to the next two turns of that character, then marked
   delivered and expires after 3 real days of play or when the character has brought it up twice (counted by delivery, not by
   parsing her words). A **met** entry produces no note (nothing to remember beyond normal conversation); a late pending appointment
   adds "you are on your way to meet V at {place}" and a waiting one "you are waiting for V at {place}".
3. **Long-term**: local routes (Mistral, Local AI, Custom): `memory.record({profileKey, channel:'phone', v, r})` with a synthetic
   exchange (V: "[V did not come to the meeting at {place}]", her angry text) so the existing extraction turns it into an `event` or
   `relationship` record. Convai: its provider memory only learns from real turns, so layers 1 and 2 are what it has; the first time
   V answers her about it, Convai's memory can keep it. No new write path to the provider is invented.

## Edge cases

| Case | Decision |
| --- | --- |
| Pathing stuck, very far | Stuck ladder above (retry, then re-spawn close, at most two, then appear near or fail). Trip cap `max(90 s, 2 x estimate)`. |
| Interior, elevator, door, no navmesh | The spot finder needs a same-floor route (Δz within 0.9 m). Megabuilding corridors and apartment hallways qualify when connected. An elevator or a locked door is not a route: candidates are taken only on V's floor. If V is inside a room with no outside route she appears in the nearest connected space out of sight, 8 to 25 m of walking, and the arrival text still counts as arrival. Nothing rides lifts. If no candidate exists the appointment fails with a sorry text and no stood-up memory. |
| No road for Car | Walk, one log line (`Immersive invitations: no road near, walking`). The character was told the method was her own business. |
| Car cannot reach or gets stuck | Deleted out of sight, replaced by a close walking visitor. |
| V in combat, scene, dialogue, call, menu | `held`: text queued, clock paused, never leaves, never meets. |
| V in a vehicle | Meeting counts for a stopped vehicle within 10 m; a moving vehicle is `held` only for the text, not for the wait clock beyond 30 s (so driving past does not freeze her forever). |
| V fast travels | Visitor deleted, appointment virtual, she still goes to the spot and still texts; materializes standing when V comes within 250 m. |
| Save/load, CET reload | See Persistence. |
| "Never mind" | `cancel-meet` action while an appointment exists (offer carries `cancel`): visitor removed (walks away if V sees her, else quiet), car deleted, no angry text, no stood-up memory, a short plain text from her only if the provider budget allows (optional). Also a **Cancel** row for the appointment in Current party (Dismiss for a visitor, Cancel invitation for a scheduled one). |
| Several companions | Independent appointments, one job each in the manager queue (limit 8 preparing at once is the queue's own), distinct spawn spots, at most 3 cars at a time (the rest walk), arrival times jittered by a few seconds so they do not text together. |
| Already in the party | Offer unavailable with `already-here`; manager Invite is the existing party add (no appointment). |
| Already pending | Offer unavailable with `pending` (she can say she is on her way, or accept a new place and replace). Manager Invite on a pending character does nothing and says so. |
| Feature turned Off | All appointments cancelled quietly, visitors and cars removed when out of sight (immediately if V cannot see them), module tables dropped. Her cars are removed too. |
| She dies, goes missing, is attacked | Failed silently (a Developer-mode notice); no stood-up memory. A visitor is a normal friendly copy; combat near her uses the game's AI like any NPC. |
| Characters that may be invited | Today's rule only. Game-placed story characters stay talk only. Only the mod's own copy is ever spawned. |
| Dismiss from the manager | A visitor can be dismissed as any copy (the manager shows her as "on her way" or "waiting"); that cancels the appointment. |
| Two requests, different places | The later one replaces the earlier. |
| V arrives first | She is still travelling: she completes the trip in sight, the arrival text is sent when she arrives, meeting follows. |

## FPS, latency, unloading

* Off: nothing loaded, nothing scheduled, no offer, no file read.
* On, nothing pending: one table-empty check where the module is called. No timer, no query.
* Scheduled: one clock comparison at 1 Hz. No entity, no native call.
* Active (a visitor exists): the existing step cadence (0.1 s accumulation in `companions.update`), at most 4 Hz of module work:
  `actuator.sense`, one progress comparison, a visibility check every 2 s only while she is closing in on a spawn, the meeting
  distance check at 2 Hz while waiting. No per-frame query. Spot searches spend the shared spatial budget and defer.
* Movement is AI commands only; the only teleport is none.
* Breadcrumbs: only when the setting is On **and** the method is Car, on the existing tick, only while V is mounted and moving.
* Latency: the ask-to-reply path gains the offer (a handful of fields) and, for text-route providers, a decision call that today
  runs only when the screen finds an action word, so ordinary phone chat pays nothing. Preparation of the companion (memory, voice,
  connection) starts at `tSpawn - PREP_LEAD` (45 s) for timed arrivals so she is ready when due, and at once for Right now.
* Unload: appointments end -> tables empty, the cars' data stays only as small records; the lazily loaded module is kept (a few KB) but
  holds nothing; Off unloads it. A joined visitor is an ordinary party member and the existing unload rules (connections, voice) apply.

## Both game versions

All APIs named above are used by code already shipped for both builds (placement, actuator, vehicle native, chauffeur native, phone
chat) or are scriptable classes present in both script sets. `PreventionSpawnSystem:GetNearestRoadFromPlayerInfo`,
`VehicleObject:IsInTrafficLane`, the fast travel point rows, `AIVehicleDriveToPointAutonomousCommand` and the AutoDrive destination
getters are present with the same names in the installed scripts of both builds (the 2.5 Steam folder and the 2.31 copy, read
2026-10-25; only the names and signatures were compared, behaviour is a live matter). `GameVariant.reds` stays the only redscript that
differs, and nothing in this feature needs redscript. Any call that differs in 2.5 goes through a small adapter in the module following the
`GameVariant` pattern (a function that returns the value or `nil`), with the Lua fallback being Walk.

## Files

New: `mod/immersive-invitations.lua` (appointment table, state machine, clock, settings view, persistence, offers, texts, ledger),
`mod/immersive-spots.lua` (spot finder and road/car helpers, game-API bound, injectable for tests),
`bridge/appointment-events.mjs` (the proactive phone turn: prompts for `arrived`, `stood-up`, `cancelled`, the template fallback keys),
`docs/IMMERSIVE_INVITATIONS.md` (this file, updated as the work lands), tests listed below.

Changed: `mod/companions.lua` (visiting state, `invitation.appointment`, `visitors()`, `joinVisitor`, fast travel hook),
`mod/manager-party.lua` (appointment-aware job: quiet joined notice, gate, Cancel row), `mod/manager.lua` and `mod/manager-ui.lua`
(settings, sub-page, button), `mod/init.lua` (phone drain/J key/Invite routing, per-step call, offers for phone and holocall),
`mod/gameplay-actions.lua` (contact-keyed lease for the meet offer), `mod/phone-chat.lua` (proactive turn, received bubble),
`mod/holocall.lua` (offer in call turns), `mod/turn-context.lua` and `bridge/turn-context.mjs` (appointment note),
`bridge/companion-actions.mjs`, `bridge/text-actions.mjs`, `bridge/text-action-words.mjs` (meet actions), `bridge/phone-chat.mjs`
(offer and event requests, action in the reply), `mod/companion-chauffeur*.lua` and `mod/companion-vehicles.lua` (her-car source, phase 2),
`mod/companion-reload-cleanup.lua` (the new car tag), `bridge/game-state.mjs` (the state file), the 15 `mod/locales/*.lua`, README
settings table, `docs/MANAGER_UI.md`, `docs/PHONE_CHAT.md`, `docs/SETTINGS_MATRIX.md`, `docs/COMPANION_CHAUFFEUR.md`.

## Phases and tests

Phase 1: settings page and switch; appointment table and state machine; walk arrival with hidden spawn; arrival and stood-up texts
with fallback; wait; meeting; stood-up memory; manager Invite and J key routing; phone and holocall offers and the three actions;
persistence; edge cases except Car.

Phase 2: car arrival (road end point, car spawn, drive, stop, get out), her car registry and persistence, drive-me with her car.

Tests (Lua through fengari like `bridge/companion-chauffeur.test.mjs`, bridge tests with `node --test`):

* `immersive-invitations.test.mjs`: state machine with a fake clock and fake game seams: every transition and its guard, frozen
  clock while paused, held states, replace, cancel, feature Off at every state, several companions, ledger bounds, no entity while
  scheduled or virtual.
* `immersive-persistence.test.mjs`: write/read, save keys, timeline drop, restore of each state after a load, CET reload, corrupt
  or missing file, atomic write, no repeat of a sent text.
* `immersive-spots.test.mjs`: the spot finder against a scripted navigation seam (hidden rule, minimum distance, ring order, budget
  deferral, route length bound, floor bound, shared spots, relaxations); the car candidate order and rejection.
* `immersive-gating.test.mjs`: nothing loaded or run when Off, who may be invited today, already in party, pending, story
  characters, passenger-only, the offer content and the token lease (late, wrong token, other contact, other world).
* `immersive-companions.test.mjs`: `visiting` entries ignored by formation, fast travel and recovery; `joinVisitor` produces a
  normal `ready` member; deletion and reload cleanup of visitors and cars.
* Bridge: `text-action-words`/`text-actions` meet codes and the screen (all languages' stems, look-alikes that must not trigger),
  `companion-actions` meet names and parsing, `phone-chat` offer and event round trip, `turn-context` appointment note (wording,
  delivery count, expiry), `appointment-events` prompts and the fallback.
* Locales: all new keys in all 15 files, `Extract-UiCatalog.mjs --check`.

## What only a live run can settle

1. A copy with **no follower role** idles quietly for minutes (`AINoRole`, no crowd behaviour) and takes `AIMoveToCommand`
   walks over 100 m. Fallback: give her the follower role from the start and rely on the commands, as party members do.
2. `GetNearestRoadFromPlayerInfo` and the AutoDrive road end point return usable road positions where V stands and for a pin far away.
3. A spawned car answers `IsInTrafficLane()` true quickly on a lane (the road test), the breadcrumb band works, and
   `AIVehicleDriveToPointAutonomousCommand` with a small `minimumDistanceToTarget` stops on the road, not at the kerb, at the road end point.
4. The driver can be seated at spawn (spec or instant mount) with no visible pop, in a spot V cannot see.
5. A mod-spawned car works with the chauffeur code (`IsPlayerVehicle()` may be false); the her-car source relaxes exactly that check.
6. Fast travel point rows list undiscovered points and expose a position (for the landmark); otherwise the geometric words.
7. Out-of-sight spawning reads as natural: no visible pop at 35 m, the hidden test agrees with what V sees at the edge of the view.
8. Meeting, waiting and the stood-up exit look right: she stands facing V, the departure walk is not instant, a parked car in view is
   deleted only after V looks away.
9. Interiors: V's apartment (H10 corridors), a bar interior, a lift hallway: the spot finder finds a same-floor route or fails cleanly.
10. Timing: the speed constants (walk, run, car) give arrivals within a few seconds of the chosen delay.
11. Provider paths: the meet action reaches the game from phone Chat and from a holocall on Convai (the action config on the text
    connection) and on Mistral/Local/Custom (the decision step); the arrival text arrives within the fallback window.
12. No measurable FPS change with the switch On and an appointment waiting, or a visitor walking.

## Open questions for the owner

1. **Does meeting mean she joins the party?** Default: yes, she joins when V reaches her. Alternative: she stays a visitor (standing
   at the spot, talkable) until V says "come with me", which needs the retired follow action to come back for visitors only.
2. **Manager Invite and the Contacts J key**, with the feature On: they create the same appointment with the page's defaults. Is a
   "summon now" escape hatch wanted (for example holding a key), or is turning the switch Off the escape?
3. **Which words when both a waypoint and "here" are possible?** Default: a clear "here" wins, otherwise the waypoint.
4. **Real minutes while paused**: default freezes the clocks when the world is not running (menus, loading, closed game). Or count
   wall-clock time including menus?
5. **Waypoint place names**: the game cannot name an arbitrary map point. Default: nearest fast travel point name plus V's district
   when close, otherwise "about N km direction of {V's district}". Is a hand-made coarse district map (shipped data) wanted if that
   is too thin?
6. **Her car**: delete only when she leaves or is dismissed (default), or also forget it after some real days unused? A car left
   parked on a street for good is the cost of persistence.
7. **Cars at once**: 3 (default), the rest walk. Fine?
8. **Characters without a driving ability** (Alt) always walk. Anyone else who should not drive?
9. **Extra rows**: "Go to my waypoint when one is set" and "She texts you" are proposed. Anything else for the page (for example a limit
   on how often she can be invited, a "never from this character" list)?
10. **Cancel text**: when V says "never mind", does she send nothing (default, the reply in the conversation is enough) or a short text?
