# Immersive invitations

Status: built on branch `feat/immersive-invitations` (2026-10-25), phase 1 (walk arrival, texts, waiting, meeting, memory) and phase 2 (car
arrival, her car, a ride in it). Source and fixture tests pass; **nothing has been seen in the game yet**: the list in "What only a live run can
settle" is what to check first. Off by default; with the setting Off nothing of this feature is loaded or polled.

A player's request: call or text a companion, ask her to meet V at V's place, a bar or a waypoint, and have her really travel there, text when
she arrives, wait a while, and leave (remembering it) if V never comes. The owner's decisions of 2026-10-25 are in "Rules the owner set".

## Rules the owner set

1. A sub-page **Settings > Companion behavior > Immersive invitations**, Off by default. Off: Invite, the Contacts J key and a text behave as before.
2. **Meeting means joining.** When V reaches her she joins the party without a respawn and says a short in-character greeting (spoken and
   subtitled through the normal turn path, with a plain localized notice as fallback).
3. **Invite button and Contacts J** with the setting On make the same appointment as a text. Off: instant, exactly as before. There is no separate summon.
4. **Clocks freeze while the game is paused or closed**: play time only.
5. **Her car** is removed when she is dismissed, or when V and she are far from it. It is not kept parked for ever and not respawned after a
   load. Drive-me uses it only while it exists and stands near V.
6. **Car arrivals at once: 3**, the rest walk. **Nobody always walks**: Alt Cunningham drives like anyone (fallback car; the passenger-only rule was removed).
7. **Destination**: V's current place by default. The map waypoint **only when V asks for the waypoint** ("meet me at my marker").
8. **Cancel** ("never mind") before she arrives: she texts back in character and lightly remembers it.
9. No settings rows beyond the six below. The hand-made district map is built only if live tests show the waypoint place names too thin.

## The settings page

`settings.immersive` (one saved table, `mod/manager.lua`; the page is `immersiveRows` in `mod/manager-ui.lua`, view `immersive-invitations`, Back goes to
Settings, Restore defaults covers it):

| Row | Values | Default | Key |
| --- | --- | --- | --- |
| Immersive invitations | Off, On | Off | `enabled` |
| How she arrives | Walk, Car | Walk | `arrival` |
| When she arrives | Right now, In 2, 5 or 10 minutes | Right now | `delay` (0, 2, 5, 10) |
| How long she waits | 2, 5, 10 minutes | 5 | `wait` (used when she arrives right now; a timed arrival waits as long as the delay) |
| Meet at my waypoint when I ask | Off, On | On | `waypoint` |
| She texts you | Off, On | On | `texts` |

A bad saved value falls back to the default and the file is rewritten clean; an Apply with an unknown field or value is refused whole. The state
file `runtime/immersive-invitations.json` is a player-state file (`bridge/game-state.mjs`, `packaging/runtime-exchange.json` class `state`), so Mod
Organizer 2 keeps it.

## How it runs

```
init.lua  convaiImmersiveTick (every 0.1 s of play, one table read while Off)
  -> mod/immersive-service.lua      glue: builds and hooks the controller on the first On, drops everything on Off, binds the save line
       -> mod/immersive-invitations.lua   the appointment table and state machine (pure, env seams)
       -> mod/immersive-world.lua         the game side: position, places, waypoint, spots, her car
            -> mod/companions.lua         visiting copies, spot search, mount wrappers
            -> mod/immersive-car.lua      the car trip sequencer and its native calls
       -> mod/place-words.lua             district records as words
```

While the setting is Off `convaiImmersiveTick` reads `manager.immersive().enabled` and returns: no module beyond that is loaded and no offer is made.
Turning it Off drops the controller (quietly ends every appointment, removes bodies and cars), unsets the hooks and releases the glue.

### Asking

| Way | Behaviour |
| --- | --- |
| Manager **Invite**, Contacts **J** | `controller.requestInvite(key)`: an appointment to V's place now. A character already in the party takes the old instant path (Add copy). A pending one answers "{name} is already on the way." |
| Phone Chat text | The pending message carries a **meet offer** (`mod/phone-chat.lua` `captureMeetOffer`). The bridge (`bridge/meet-requests.mjs`) screens V's words in the game's menu languages, adds an instruction to the turn, and strips a leading or trailing tag (`[meet-here]`, `[meet-waypoint]`, `[cancel-meet]`) from her reply; a valid one comes back as `action` in `phone-chat-output.json` and the game checks it against the offer's one-use token. Works on Convai, Mistral, Local AI and Custom alike. |
| Talking to her while she waits | She is a managed copy (`companions.identity` accepts `visiting`), so the talk key works; her turn context says she is waiting for V. |
| Holocall (typed or spoken) | A call line carries the same kind of meet offer and a **decision step after her reply is complete**; see "Holocalls" below. |

Offer content: `kinds` is `["here"]`, or `["here","waypoint"]` when the player's own map pin is set and the row allows it; the place words of each; the ETA and
the wait in minutes. Unavailable offers carry only a reason (`already-here`, `pending` with a cancel token, `combat`, `busy`) so she can decline in
character. The destination is frozen when the message is sent. **Which kind:** the tag she writes is checked against V's words: `meet-waypoint`
needs V to have named the waypoint (marker, pin, map, ...), otherwise it becomes `meet-here`.

### Where is that place

`here`: `currentDistrict()` (PreventionSystem record) worded by `mod/place-words.lua`, the Lua copy of `bridge/place-names.mjs` (a test keeps the two tables equal),
for example "Lizzie's Bar, Kabuki, Watson". `waypoint`: the tracked pin (`AutoDriveSystem` destination type `PlayerTracked`, never a quest marker), its own name
when the game gives one; otherwise "near {nearest fast travel point} in {district}" (`FastTravelSystem` rows, within 250 m), "near {V's district}" when the pin is within 150 m of V, and
last "about 1.4 km north-east of {V's district}". The game has no position-to-district query, so the words are always one of these.

### The appointment

One per profile; a second request replaces it. Phases: `scheduled` (nothing exists) -> `preparing` (the party queue prepares memory, voice and connection through
a quiet job whose `gate` holds the spawn; a hidden spot is found) -> `en-route` (her body walks or drives) -> `waiting` (body `visitor`, or `virtual` when V is far)
-> `met` (she joins) or `leaving` (stood up) or removed. Clock: play time, frozen at zero frame delta (menus, loading); a step is 0.5 s.

* **Virtual and materialized.** A body exists only while V is within 250 m (hysteresis 350) of the spot. Far away, an appointment is data and two numbers: the
  arrival text still comes at its time, the wait clock runs, and when V comes within 120 m a waiting companion gets a body standing at the spot (hidden spot of 3 to 8 m).
  A fast travel deletes visiting bodies first (`companions.beginFastTravel`) and the appointment goes on virtually.
* **Timed arrivals** start preparing `45 s + trip` before the arrival time and spawn at `arrival - trip`; the trip estimate comes from the spot (path length / 1.5 m/s walking,
  8 s + road distance / 10 m/s + the walk for a car). She runs when behind schedule.
* **Held**: while V is in combat, a scene/dialogue or a call, her text waits, the wait clock does not run and she cannot leave or be met.

### Walking in

A visitor is a normal managed copy with `entry.visitor` and state `visiting` (`mod/companions.lua`): created at the chosen spot, **no follower role**, ignored by every
party loop (they key on `ready`). She walks by `companion-actuator.lua` `board(..., {navigate = true})` (native `AIMoveToCommand`), never by teleport. The hidden spot
(`companions.findVisitorSpot`): rings around the meeting place, starting behind where V looks, at 90 down to 18 m (35 m minimum on foot, relaxed in steps to 8 m), each
candidate on the navmesh, out of sight (`hiddenFromPlayer`), with a route that is no detour (at most 1.35 x straight + 6 m, 160 m, within 2.5 m of the floor), a body that fits,
and not near another visitor; at most 3 candidates judged and 12 ring points looked at per call within the shared query budget (a spent budget means "ask again"). Ring points are every 15 degrees and snap to the nearest walkable ground within 2.5 m, or 6 m from 14 m out, so a narrow street is found; later rungs also accept a longer way round (2 x + 15 m) and a 4 m slope. A spent ladder logs ONE probe line, `failed: no spot (walk0 of=.. nav=.. dup=.. floor=.. near=.. seen=.. route=.. body=.. avoid=.. | walk1 ...)`, the counts of the check that turned candidates away on each rung. Stuck (no 1 m progress in 10 s): re-issue; three stalls or a trip
cap of `max(90 s, 2 x estimate)`: delete her and appear 14 to 30 m away; at most two respawns, then a plain failure text.

### Arrival, waiting, meeting, leaving

* **Arrival text**: a phone turn with an `event` (`arrived`, with place and whether she came by car) and no typed line; the bridge writes it in her voice
  (`bridge/appointment-events.mjs`). Any failure or a 45+ s delay shows the plain localized line (`ui.t`). A notice shows it too. Nothing is sent with "She texts you" Off.
* **Meeting**: V within 5 m (same floor within 3 m) for 1.5 s. `companions.joinVisitor` sets the follower role on the same body; then the greeting
  (reaction kind `meet`, `mod/init.lua` `convaiMeetGreeting`) waits up to 20 s for a free channel and falls back to a notice.
* **Stood up**: the wait ends (not while held): an angry text (`stood-up` event), a ledger entry, and she walks off (`leaving`) until V cannot see her, is 50 m away, or 90 s pass; nothing
  is simulated when V is far.
* **Meeting her on the way** (2026-10-25): the same meeting counts while she is still `en-route`. On foot: V within 5 m, same floor, for 1 s (`MEET_DWELL_ROUTE`) and she stops her walk and joins with the normal greeting. In her car: V within 10 m of the car halts the drive (`sequencer.halt`: brake, animated exit), she walks to V and joins at 5 m, and the car becomes hers. A virtual appointment has no body, so nothing can be met.
* **Never mind**: `cancel-meet` (offered while an appointment exists). A plain call-off in V's words (`screen.sure` in `bridge/meet-requests.mjs`: "actually no sorry", "never mind, stay where you are", ... in the 15 languages, no meeting word left over, not "I never mind waiting") cancels **without her tag**; she is told to answer briefly in character, her tag is the second route. While she drives, body and car go at once. A short `cancelled` text, a ledger entry, the visitor walks off, no stood-up memory.
* **A call-off said to someone else** (a talk or voice turn with a companion at V's side, "never mind, cancel that"): `bridge/call-off.mjs` screens V's words with the explicit call-off stems only (`plainCallOff`; the loose ones such as "no thanks" count only for the person V arranged it with), writes `runtime/call-off.json` and adds nothing to the turn and no model request. `mod/immersive-service.lua` reads it once a second while a meeting stands (never before one stands, once per id) and `controller.callOff` ends the one standing meeting; with several standing, only the one whose name V said. The offer for a message to her still comes first: her walking body is in the companion list from its spawn, and "already here" must not hide the pending meeting (live 2026-10-25, Claire Russell: "actually no dont come" did nothing).
* Dismissing a visitor in Current party ends the appointment quietly. A scheduled one shows as a row with **Cancel**.

### Memory

Three layers: the text is in the phone history (and the next phone turns see the last six rows); a note rides on her next turns on **every** channel
(`turnContext.appointment`: on-the-way, waiting, stood-up (brought up at most twice), cancelled (once)); the local text routes also get a synthetic exchange
("[V did not come to the meeting at {place}]" and her text) so the memory store extracts an event. Convai's provider memory learns only from real turns, so layers 1 and 2 are what it has.

### Her car

`mod/immersive-car.lua`. The method is the **How she arrives** setting, not V's words ("by car" in a message changes nothing; the bridge only passes a meet tag). A car arrival needs a
**road end point**: for "here" the engine's `GetNearestRoadFromPlayerInfo` (within 60 m on foot), else the nearest point of V's recent drives within 150 m, else, when the engine's answer is
empty or unreadable (`call-failed`, `no-system`, `no-info`, `no-point`, `zero-point`), V's own spot as a guess (the car's driving AI finds the road; a drive that cannot be made walks, see the codes);
for the pin the AutoDrive road end point. With none, she walks (the request is turned into Walk at once).

**Why she walked is in `probe.log`**, one code word per fall back: `Immersive invitations: X will meet V (here, walk, ..., walks: <code>)` with `setting-walk` (no line suffix when the setting is Walk), `cars-busy`,
`no-road:<code>` (the road lookup: `far:<m>`, `no-path`, `invalid`, `no-pin-road`, or the unreadable codes above, when no trail point helped); a car appointment says `road engine|trail|guess`; the next line
`X: road lookup point=.. pathLength=.. (<code>)` shows the fields the engine's lookup returned. Later: `X: no car arrival, walking (no-road-spot: ...)` (two searches found no spot; the reasons follow),
`(off-lane: ...)` (the new car never stood on a traffic lane, after `LANE_RETRIES` = 3 other spots), `(car-not-made: ...)`, `(not-attached|car-gone: ...)`, `(trip-failed: ...)`.
A car that does not stand on a lane is replaced by the next candidate spot (`trying another spot (n)`) before she walks; the second search round also accepts spots in V's sight (130 m or more away). The car spot (`companions.findCarSpot`): points V drove through lately (a 40-point trail sampled every 2 s only while Car is
the method and V is in a moving vehicle) and rings of 130 to 220 m around the road end point; each must be out of sight, 60 m from V, pass the party-car footprint test
(`companion-vehicle-native.lua` `clearAt`) and have walkable ground beside it for the driver. The car (the character's catalog car or the fallback, tag
`CyberpunkConvaiHerVehicle`, never the carpool's tag) must report `IsInTrafficLane()` within 2 s or it is deleted and she walks. The sequence: she appears beside the car, boards (animated
`AIMountCommand`), drives `AIVehicleDriveToPointAutonomousCommand` (the chauffeur's flags, 12 m/s, stop distance 6 m) to the road end point, the car brakes, she gets out (animated unmount, instant
failsafe after 8 s), and walks the rest. Any failure deletes the car and she walks in from 14 to 30 m away (two tries, then a plain failure).

At the meeting the car becomes **hers**: `herCars[profile]` in memory only. It is deleted when no companion of that profile is in the group for 10 s (dismissed), or when V is more than 150 m
from it for 6 s (with her), or when the setting goes Off. A load drops the references; nothing is saved. A car that will not delete (V sits in it, a passenger) is asked again every 2 s, 30 times.
**Drive me**: `mod/companion-chauffeur-native.lua` takes her car as the car source when V has no car of V's own to use and hers stands within 25 m of V (the offer then wants 20 m, as for V's own car; two globals,
`convaiCompanionCar` and `convaiCompanionCarIs`, set only while the setting is On); the lease keeps a `companionCar` flag and her car always takes the Lua sampling path (the plugin's chauffeur
sampler knows only cars V owns). Everything after that is the existing chauffeur.

### Edge cases

| Case | Decision |
| --- | --- |
| Stuck, very far, no route | Stuck ladder above; spot search relaxes (minimum distance 35 -> 14 -> 8 m, then visible but 8+ m away), then a plain failure text and no memory (the phone history gets her line directly, no bridge turn, plus a notice). |
| Interior, lift, no navmesh | Spots need a route within 2.5 m of the floor, so a lift or a different floor is not a route; in a room with no outside route she appears in the nearest connected space. Nothing rides lifts. |
| No road for Car | Walk, with the code in the log (see "Her car"). Car cannot be made, still off a lane after the retries, cannot attach: Walk. |
| V in a scene/combat/call | Held (text queued, clock paused). A menu or the phone is a zero delta: the clock is paused anyway. |
| V fast travels | Visitor deleted first, appointment goes virtual, her car with it; she still arrives and texts; a body appears standing when V comes within 120 m. |
| Save/load, CET reload | Appointments are saved per save line (`campaign:branch`, or this session only without a save identity) with remaining seconds; a record created after the loaded save (ledger sequence) is dropped; a load drops bodies and cars without touching the game. |
| Several companions | Independent appointments; at most 3 car arrivals at once; spots avoid each other. |
| Already in the party | Offer `already-here`; Invite takes the old path. |
| Who may be invited | Today's rule only (`companions.definition(key)`): game-placed story characters get talk only; only the mod's own copy is ever spawned. |
| Feature turned Off | Every appointment, body, car and offer is dropped (bodies and cars removed). |

### Performance

Off: one table read per 0.1 s tick. On and idle: the same plus a few comparisons per 0.5 s step; the controller reads no game state when it has nothing to do (tested). A step with an
appointment is a handful of native reads. Spot searches spend the shared per-update query budget and defer. Movement is AI commands only; this feature never teleports. The trail runs only for Car
arrivals while V drives. Nothing is polled per frame beyond the delta add.

### Holocalls

A call reply streams straight to the voice, so a tag cannot be taken out of it. A call therefore asks for a meeting the way a companion action is asked
for (`mod/gameplay-actions.lua` lease, `runtime/companion-actions.json` mailbox), and the result goes through the same one-use token check and the same
appointment flow as a text (`controller.offer` / `controller.accept`).

* **Game**: for a context with `holocall`, `gameplayActions.capture` leases **only** a meeting offer (never a ride, fight, follow, leave or reaction: the caller
  is not here). `options.meetOffer` -> `convaiMeetCallOffer` -> `service.callOffer` asks the controller for the phone's offer (frozen places, one-use token, 180 s
  of wall time), wrapped as `{available, actor: {id, key}, meet}`. It is `available` when she could agree (an open offer, or a standing meeting that may be
  cancelled). A call line she cannot answer with a meeting (combat, no place) still carries the offer with `available = false` so her note says so; a character already
  with V gets none. Typed lines are captured in `sendRequest` (the holocall branch), spoken ones in `microphone.captureActions` at the key press. With the setting
  Off `convaiMeetCallOffer` is one table read and nothing is asked. The packet that answers it is `action = 'companion-meet'` with `meet` (`meet-here`,
  `meet-waypoint`, `cancel-meet`), `meetToken` and the echoed `meetOffer`; the lease compares the request, person, world, source, offer and token, spends
  itself, and calls `queueMeet` -> `service.callAccept` -> `controller.accept`. A stale lease (the next line of the call) refuses it.
* **Her note** (`bridge/call-meet.mjs`, `callMeetNote`): a short block in the volatile context (no tags): where V is, how long she would take and wait, the
  waypoint if there is one, "if V clearly asks you to come and agree, say so in character", "never promise to come unless you really mean to", and for a
  standing meeting how V may call it off. A typed line that cannot be about a meeting (the multilingual screen of `bridge/meet-requests.mjs`) adds nothing; a
  spoken line (its words are not known when the context is made) always carries the note. A reason she cannot come (combat, busy) is told the same way.
* **Mistral, Local AI, Custom** (`TextProviderHost.decideMeet`): after her reply is complete (`publishResult` starts it, **not awaited**, so it can never delay
  the reply, the face or the voice), if V's words pass the screen and the offer allows the kind, one tiny request with no persona reads V's call line (the
  typed text, or the recognised words of a spoken one) and her reply and answers `MEET`, `WAYPOINT`, `CANCEL` or `NONE`. **The waypoint is a choice only when
  V named it**; a cancel is a choice only when a meeting stands. A plain call, small talk, a refusal, a failed or unclear answer, a slow model: nothing is made
  and nothing waited for. It is background work: on Mistral it queues behind turns on the account's scheduler; on the Local AI it is a `background` lease (asked again up to three times when other background work holds the slot) that
  a turn stops (as it stops a summary), with the line "call meeting decision put off". The answer goes to `CompanionActions.deliver` like any action.
* **Convai** (`bridge/companion-actions.mjs`): the call turn arms the turn's action list with `Meet V Here <token>`, `Meet V At Waypoint <token>` (only when the offer has
  a waypoint) and `Cancel Meeting <token>` (only when a meeting stands) plus a short prompt block; the model requests one in the same reply. A call needs no
  Convai memory identity for this (the game's token authorizes it); the action list is armed only where Convai arms it for any private turn. If the Convai page cannot
  take the action list, the call note says the request will have to wait.
* **What a reply may promise**: the decision cannot hold back a reply that has already started to speak, so the note tells her to agree only when V clearly
  asked, and to say so when she cannot (the game's reason is in the note). If the game still refuses (the world changed, the offer expired), nothing happens and she
  has said she is coming; the log has the line (`Call meeting hand-over rejected: ...`). The live check below looks at how often that happens.
* **Log lines** (codes only, never words): `call meeting: meet-here` / `none`, `call meeting meet-here handed to the game`, `call meeting decision failed: <kind>`,
  and the game's `Call meeting packet refused: <rule>`.

## Files

New: `mod/immersive-invitations.lua`, `mod/immersive-service.lua`, `mod/immersive-world.lua`, `mod/immersive-car.lua`, `mod/place-words.lua`, `bridge/meet-requests.mjs`,
`bridge/appointment-events.mjs`, `bridge/call-meet.mjs`. Changed: `mod/companions.lua` (visiting copies, `findVisitorSpot`, `findCarSpot`, mount wrappers, fast travel hook), `mod/companion-vehicle-native.lua` (`clearAt`, `spawnAt`, tag-aware
`destroy`), `mod/companion-chauffeur-native.lua` (her car), `mod/companion-vehicle-catalog.lua` and `mod/companion-vehicles.lua` (Alt drives), `mod/manager.lua`, `mod/manager-ui.lua`,
`mod/manager-party.lua`, `mod/gameplay-actions.lua` (the call's meeting lease), `mod/init.lua`, `mod/phone-chat.lua`, `mod/microphone.lua`, `mod/nsui.lua`, `mod/mcm-host.lua`, `mod/notices.lua`, the 15 locales, and in the bridge `phone-chat.mjs`, `protocol.mjs`,
`battle-context.mjs`, `turn-context.mjs`, `companion-actions.mjs` (the call's action), `convai-bridge.mjs`, `text-provider-host.mjs` (`decideMeet`) and friends (see `git log` for the exact list).

## Tests

`npm run test:immersive` runs them. Lua state machine against fake seams: `immersive-invitations.test.mjs` (43: every phase, the frozen clock, held, offers and answers, virtual arrival,
fast travel, persistence, cars and their lifecycle), `immersive-car.test.mjs`, `immersive-service.test.mjs`, `immersive-companions.test.mjs` (visitors in the real `companions.lua`),
`immersive-phone.test.mjs`, `immersive-settings.test.mjs`, `immersive-place-words.test.mjs`, `immersive-vehicle-spot.test.mjs`, her-car cases in `companion-chauffeur-native.test.mjs`; bridge:
`meet-requests`, `appointment-events`, `phone-chat-meet`, `turn-context-appointment`, and `call-meet.test.mjs` (21: the offer parser, the note, the plan and the decision request, the lease in
a Lua VM over the real service and controller, and the whole path for the text route and for Convai: a call that says "come meet me" makes an appointment, one that names the waypoint uses it,
"never mind" cancels, a plain call makes nothing and costs no request, the decision never delays the reply and is background work, and the game refuses a wrong token, kind, request, world, offer or an expired lease).

## What only a live run can settle

1. A copy **with no follower role** idles for minutes (no crowd behaviour) and takes `AIMoveToCommand` walks over 100 m; she stands still after arriving. (Fallback: give her the role from the start.)
2. Hidden spawn at 35 m reads as natural, she walks in at about 1.5 m/s and arrives within a few seconds of the chosen delay; the out-of-sight rule agrees with what V sees at the edge of the view.
3. `GetNearestRoadFromPlayerInfo` (via `Game.GetPreventionSpawnSystem()`; the out-parameter return form) gives a usable road point where V stands, and the AutoDrive end point does for a far pin.
4. A spawned car answers `IsInTrafficLane()` true on a lane within 2 s; trail points are accepted; ring candidates mostly fail (then Walk); the drive stops on the road, not at the kerb, and about as close to V as the road end point (target aimed with a 3 m stop distance, moved 8 m back along the car's approach when it would lie on V's spot); the animated boarding and
   exit work in the dark, and the driver ends on the sidewalk side.
5. Her car in drive-me: the offer is made (`IsPlayerVehicle()` may be false for it, handled by the hook), `GetInitCmd()` does not make the car look "busy", V can enter a passenger seat.
6. Fast travel points list a position through their mappin; otherwise the geometric words.
7. The tag works: she tags `[meet-here]` on Convai and on a text provider; the arrival text arrives in her voice within seconds or shows the plain line.
8. The meeting: 5 m for 1.5 s joins her, the greeting plays (or the notice), formation takes over, she boards V's car with the party.
9. Interiors: V's apartment, a bar, a lift hallway: a same-floor spot is found or the failure is clean.
10. No FPS change with the setting On and an appointment waiting, a visitor walking, or a car driving.
11. **Holocall meetings**: on a call (typed and spoken, on Convai and on a text provider) "come meet me" makes the appointment within a second or two of the end of her reply (look for `call meeting: meet-here` and
    the notices), the waypoint only when V names it, "never mind" cancels, a plain call makes nothing, and her reply never waits for the decision. How often she says she is coming but the game made nothing
    (the log lines above), and whether the Convai model requests `Meet V Here` reliably on a call (the NPC reaction line of the turn shows what its page did with the offer).

## Open items

* **Holocall**: built (see "Holocalls"); unseen in the game. A reply that promises before the decision cannot be taken back; the live check counts how often that happens.
* The hand-made district map, only if the waypoint words prove too thin.
* Fetching her car to V ("bring the car round") is not built.
