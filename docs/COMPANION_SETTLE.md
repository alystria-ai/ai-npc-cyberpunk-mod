# Companions settle in V's flat

Status: **built** on branch `feat/apartment-settle` (2026-10-25), source and fake-world tests pass; **nothing has been seen in the game yet**
(the list at the end says what only a live run can settle).

The owner, testing with several companions: when they sit in an apartment, they should find a place to sit or stand "so they aren't constantly
following me in the apartment". This is that. While V stays in one of V's own flats, each party companion (the mod's own spawned copies; a
game-placed character gets talk and face/audio only, as everywhere) stops trailing V and goes to a free seat or a standing place of the flat,
spread out, walking there with AI move commands. When V leaves, goes far from them, gets in a car, or a scene or a fight starts, they get up and
follow as before.

There is no setting: away from V's flats nothing of it exists (see Cost). It does **not** depend on Settings > Gameplay > Housemates
(Off by default): it uses the housemates' *data and helpers* only, never `mod/housemate-service.lua` or the controller.

## Pieces

| File | What it does |
| --- | --- |
| `mod/companion-settle.lua` | The home: knows the flat (V is in it), decides *when* they settle and *when* it ends, prepares and hands out places. Built by `mod/init.lua` when V enters a flat, dropped when V leaves. Its tick rides the companions' body animation tick. All game reads go through injected seams, so it is tested with fakes. |
| `mod/companion-seating.lua` | The existing seating controller grew a **home** (`setHome`, `clearHome`, `homeRelease`, `homeHeld`, `vSeat`, `sitting`, `canSit`, `placed`). A companion without a place asks the home for one (`claim`), then walks, sits or stands. The sit itself is the same code as beside V: device entity with the vanilla NPC sit workspot, native fast exit, step out, walk-up retries, placing out of V's view. |
| `mod/housemate-spots-data.lua`, `mod/housemate-plan.lua` | The flats and their seats and standing spots (`plan.usable` filters them), unchanged. |
| `mod/housemate-world.lua` | `prepare(spot)` finds the real cushion behind a data seed with raycasts and a way up to it (the seeds are snapped, never trusted), `proc` finds a standing place in the room when the data has no more. Used with a smaller ray budget (24 surface reads per 0.1 s window instead of 36). |
| `mod/init.lua` | The district hook, the `convaiSettle*` globals (one do-block), the tick call in `companions.bodyAnimation.tick`, the follow offer, one reset line in `abandonSession`. |
| `mod/housemates.lua`, `mod/housemate-service.lua` | Two small additions so that housemates and settled companions never take the same place (`takenSpots`, `reserved`). Nothing changes while Housemates is Off. |

## When they settle

The module exists only while V is in one of the five flats (`LittleChina_VApartment`, `CorpoPlaza_Apartment`, `Glen_Apartment`,
`JapanTown_Apartment`, `Northside_Apartment`, the housemates' list). It takes a step every 0.5 s (`M.STEP`):

* **V sits** (the seating controller's settled seat, `seating.sitting()`): 1.5 s after V entered, they settle. The ones near V that find a free
  seat beside V (existing behaviour) take it first, the rest go to the flat's places.
* **V stays**: V has been in the flat 10 s (`M.STAY`) and has not moved more than 1 m in the last 3 s (`M.QUIET`, `M.QUIET_RADIUS`). A V who
  walks on through the flat, heading for the door or another room, never reaches that.
* Not while a fight, a car or a scene is on (`held()`: combat, vehicle, and a scene that is not V's own sitting, sleeping or washing at home).
  After one, they settle again only once V has been quiet for another 6 s (`M.AGAIN`).
* Nobody in the party: nothing is read or prepared.

## Which place

Spots come from `plan.usable` for the flat: seats (couch, chair, bar, stool) and standing places (`stand`, `window`, `lean`); beds and sinks are
left out (sleeping and washing are the housemates'). Seats marked `maybeV` stay out until a seat of V's in that flat is known (V sat there during
the visit, or the data names one); V's own root (`vslot`, and any root V sits on, `learnV`) is never given away.

`claim(entry)` runs once a second per companion without a place:

1. every prepared place that is free: not held by another companion, not within 0.9 m of one (0.5 m for two cushions of one piece of
   furniture, so a two-seat sofa is two seats), not within 1 m of V, not V's seat, not within 0.6 m of a housemate's place;
2. the nearest to her, a seat counting 1.5 m nearer than a standing place (so seats fill first, then the standing places, "mostly sit, some stand");
3. no real place left and every table spot tried: a procedural standing place in the room (`world.proc`, 2.6 to 6.8 m from V, 1.5 m or more from V,
   1.2 m from the others, on the navmesh). Flats without data (Westbrook, Northside, Heywood Glen today) therefore make them stand about the room.

Places are found lazily: from 3 s after V came in (at once when V sits), at most 24 surface reads per step, nearest to V first, and only until there
are places for everybody plus one spare.
A place that fails (no cushion there, no way up, the sit never plays, the walk is refused) is dropped for the visit and the next one is tried.

**Facing of a seat (`yaw`, the direction the sitter looks, game yaw: forward = (-sin, cos)).** `housemate-world.lua` finds it with eight rays around the cushion. A couch
or chair has its backrest behind her: she faces away from the higher surface. A bar stool or a stool has no backrest, the higher surface is the counter or the table:
she faces it, as V's own seated body does on the same stool (the V-triggered path copies V's world orientation onto the device; the home path builds the same
orientation from `yaw`, `Quaternion.BuildFromDirectionVector((-sin, cos))`). Rays that see the same counter edge are averaged, so a straight counter gives a straight
facing. Until 2026-10-25 the couch rule was used for stools too: every bar stool seated on her own was turned 180 degrees (probe: corpo-bar-1 `yaw -1e-14` with the counter at -y).

## What a companion does

* **Seat**: walk to the prepared way up (AI move command), then the seating code's settle, device, workspot, hold. While seated the talk key works
  as it does for a companion beside V: eyes on V (`full` when selected, `side` otherwise).
* **Standing place**: AI move command to the spot, a turn toward its facing (the window, or away from the wall), then a hold. While V talks to her
  she looks at V and, if she is facing away, turns once toward V (at most every 4 s). Gestures and idle behaviour work as for any standing follower.
* **Never a teleport into V's view**: the only teleports are the seating code's existing "placing" fallback (only while she and the spot are out of
  V's view) and the stand-up step-out.
* **V sits on the place she holds**: she stands up and takes another.
* **A change of clothes** (docs/COMPANION_OUTFITS.md, "Seated at home"): out of V's view she lets go of the place (`homeStandUp`: native exit for a seat, at once for a post;
  `freed` with reason `outfit`, not bad) and takes no place for the hold the outfit module names (90 s at most). When the change is over the outfit module ends the hold (`homeSitAgain`, 3 s of grace) and the home's claim
  gives her a place again within seconds; the cap only covers a change that never ends. The settle timers never re-seat her mid-change. The seating probe says why a standing companion
  takes no place: `home-wait {serial, why}` once per change of reason (`outfit`, `cooldown`, `far`, `gesture`, `no place`).

## When it ends

| Event | What happens |
| --- | --- |
| V leaves the flat (district event, or the 6 s district check as a net) | `leave`: seated ones stand up with the native exit, standing ones follow at once; the module is dropped |
| V goes more than 12 m from the nearest settled companion, or to another floor (3.5 m) | all released, `watch` again |
| A fight | all released, the stand-up is the instant exit |
| A scene, a car | all released (the normal stand-up); a car also takes each companion into transport, which releases her |
| Fast travel or a load | the seating controller's release/abandon runs as before; the module is dropped and one district read after the world is up decides again |
| V says "come with me" | see below |
| Dismissed / recovered | her place goes back to the home |

### "Come with me"

A settled companion is offered the **follow action** in a conversation (the same offer and token the conversation actions know for "Follow V";
`followOffer` in `mod/init.lua`): "come with me", "follow me", "let's go" with her agreeing. The game then lets her go (`homeRelease`): a seated
companion stands up, and she takes no other place in this stay. Nothing is offered to a companion who has no place. (The old world-character
follow stays retired; only a settled party member gets this offer.)

## With housemates

If Housemates is On and someone lives in the flat, the two features share the room: the housemates' `takenSpots(apt)` are not given to
companions, and `housemates.lua` treats the places settled companions hold as taken when it plans (`reserved`). With Housemates Off nothing is
asked of it.

## Cost (the owner's rule: FPS first, latency equal)

* **Away from V's flats: nothing.** One `ObserveAfter('PreventionSystem', 'OnDistrictAreaEntered')` callback (installed in `onInit` with the other
  hooks) that reads the district when the game pushes a change (a few native calls, a few times per hour of play) and one nil global read per
  companions tick. No polling of V's position, no timer.
* **Once per world**: one district read on the first party tick of a world (a save made at home with companions already there, or fast travel into a flat), and one when V sits down on a seat anywhere (a net for a
  missed event).
* **In a flat**: a step every 0.5 s: one native read of V's position (none while the party is empty), the busy flag from the battle sample the mod
  already takes (no native call), one district check every 6 s. While a companion still waits for a place: at most 24 surface reads per step.
  Once everyone has a place: nothing more than the step. Per companion without a place: one `IsActorInWorkspot` and a Lua claim once a second.
  A settled companion costs a table lookup per companions tick (the seating steer, as when seated beside V).
* **Latency**: they start moving the tick the home is set (places prepared earlier during the watch, so the first claims usually find ready
  places); a conversation is not delayed by any of it.

## Tests

| File | What it covers |
| --- | --- |
| `bridge/companion-settle.test.mjs` | the module against a fake seating controller and spot preparer: idle costs nothing, walking is not staying, 10 s and quiet, V sitting, spreading (no two on one place, a two-seat sofa is two seats, seats first, standing, procedural), housemates' places, V's seat, bad places, no sit component, release on combat/scene/car/far/district, settle again after a quiet spell, follow offer, `taken`, bounded preparation, source checks (no game call in the module, the one hook, the nil global tick) |
| `bridge/companion-settle-seating.test.mjs` | the home half of the seating controller: standing place, seat, combat, two companions, V sits on the place, dismissal, a failed seat reported bad, release of one, far companions, claim rate, V's seats before home places, replacing a home |
| `bridge/companion-settle-seating.test.mjs` (outfit stand-up) | `homeStandUp`: released with the native exit, no claim during the hold, a place afterwards, a post let go at once, nothing to release without a home; `homeSitAgain`: the end of the change lifts the hold (also while she is still on her way up), `home-wait` says why once |
| `bridge/companion-settle-flow.test.mjs` | the whole chain on the Corpo Plaza data: three companions sit on three distinct seats, V walks off and they stand up and follow, a fight, "come with me", two more arrive |

## What only a live run can settle

1. **The district event fires for the flats.** `OnDistrictAreaEntered` is assumed to be pushed when V crosses the door (the housemates assume the same
   and were never run live either). If it does not, the safety nets are the one read on the first party tick of a world and the read when V sits; the log shows
   `Settle settle-enter` (Developer mode) when it works.
2. **An apartment with three companions** (the Corpo Plaza flat is the one with measured seats): they follow V in, V stays 10 s, they spread over the
   couch, the bar stools and the chairs, sit with the right pose, and walk there without sliding through furniture.
3. **Standing places** (H10 has two measured by Johnny's scene; the others are procedural): where they stand, their facing, that the turn looks
   natural, that they do not block V.
4. **Rejoining**: V walks to the door, leaves; V gets in a car; a fight starts; a scene starts; fast travel: every one of them gets up and follows
   again, none stays behind in the flat.
5. **Seeds snapped on the game**: the seats of H10 and the Corpo Plaza stools and chairs are archive seeds, not measurements. Each is snapped with
   raycasts; the log (`settle-spot`, `settle-spot-rejected`) says which survived. Rejected ones are simply not used.
6. **Talk**: the talk key on a seated and a standing companion, the look at V, the turn toward V.
7. **"Come with me"** to a seated companion: she stands up and follows, the others stay.
8. **With Housemates On** and a housemate in the same flat: nobody takes the other's place.
9. **Outfit change while settled**: a seated companion, out of V's view, stands up, changes into her home look and is given a place again after the hold, without a flicker
   or a double sit; the stand-up exit when she is on a bar stool.
