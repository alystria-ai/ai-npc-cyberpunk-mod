# Delamain cab add-on: research (2026-10-13)

Research only. No code, game file, archive or setting was changed; no audio was extracted; the game was not launched.
Scope: the game's Delamain cab (V calls a cab, rides, pays), what the add-on can detect and know, whether a companion can ride along, and Delamain's voice.

Installed game: Cyberpunk 2077 **2.31** (`Cyberpunk2077.exe` product version 2.31; `r6/cache/final.redscripts` and `tweakdb.bin` dated 2025-09-15).

## How to read the evidence tags

| Tag | Meaning |
| --- | --- |
| **verified (scripts)** | Found in the installed 2.31 game scripts, `E:\SteamLibrary\steamapps\common\Cyberpunk 2077\tools\redmod\scripts\...` (the names also occur in `r6/cache/final.redscripts`). This is the same source family as the NativeDB dump (CDPR's script reference); nativedb.red4ext.com itself could not be queried (see Prior art), so no entry here is "verified (NativeDB)". |
| **verified (quest data)** | Read from the game's own quest phase and scene resources, decoded read-only with the repo's pinned WolvenKit 9.0.1 into a scratch folder (`base\open_world\delamain_taxi\phases\delamain_taxi.questphase`, `...\scenes\delamain_taxi.scene`, `base\open_world\passenger\phases\thepassenger.questphase`). |
| **verified (repo)** | Already used by the main mod in `mod/` (and therefore a known-good CET name), or stated in a repo doc. "Used" is not "live-confirmed"; each line says which. |
| **verified (web)** | Stated by a source in the Prior art list. |
| **unverified** | Inferred, or the name exists but behaviour needs a live read-only probe (list in section 6). |

## 0. Findings in one page

1. **The cab came with patch 2.3 (17 July 2025).** CDPR's notes: call "Delamain Cab" from the vehicle menu after finishing *Don't Lose Your Mind* (any outcome) and getting a message from Delamain. 2.31 (11 Sept 2025) fixed Johnny always sitting in the passenger seat on Delamain rides. A Delamain car was an ordinary garage vehicle before; the taxi behaviour is new in 2.3 (web, low-confidence for the "before").
2. **The whole ride is a script state machine** with a fact `delamain_taxi_state` (0..8: None, Spawned, Parked, Ready, Started, Arrived, Cancelled, Finished, Freeroam) and a fact `delamain_taxi_seat` (1 = back left, 2 = back right). Every transition is an event the add-on can observe; no polling or per-frame work is needed (section 1.6).
3. **Vehicle:** garage entry `Vehicle.v_delamain_taxi` (used by the quest's EnablePlayerVehicle node); the physical record the quest tests is `Vehicle.v_standard2_villefort_cortes_delamain_player` (a Villefort Cortes). Four seats: `seat_front_left`, `seat_front_right`, `seat_back_left`, `seat_back_right`.
4. **Riding:** the cab drives itself through `AutoDriveSystem` in "Delamain mode" (`GetAutodriveIsDelamain()` true), there is no driver NPC, the HUD is hidden, the fare is charged at arrival or when V steps out mid-ride, and V picks a free custom map position (not a named place).
5. **Companion boarding looks possible** and nothing in the scripts forbids it: the cab component ignores every mount event that is not V's, and the AI mount task opens doors through `VehicleComponent.OpenDoor` without reading the door interaction state (the state that disables the cab's front doors). But the main mod would board companions into the cab **automatically and unguarded** (its vehicle controller accepts any `Car` V sits in), and the cab leaves into traffic soon after V gets out. Both need guards (section 1.7).
6. **Voice:** Delamain is **Samuel Barnett** (English); the GLaDOS personality is **Ellen McLain**. The installed English voice archives hold about 320 lines of the plain Delamain voice (about 1,455 s) plus about 14 personality variants (about 1,000 s). The cab itself has only **12 short lines** of its own (36.9 s, scene `delamain_taxi.scene`), plus 7 phone-call framing lines. The pool index has no Delamain voice yet.
7. **Conflict with the game's own cab dialogue is real:** the cab runs a quest scene with Delamain speaking (greeting when V sits, farewell at arrival) and may seat ambient Johnny. The add-on must stay silent during those windows (section 4).

## 1. The cab feature

### 1.1 Patch history and unlock

| Fact | Source |
| --- | --- |
| Update 2.3, 17 July 2025 added the Delamain Cab (on-demand self-driving taxi), AutoDrive, cinematic AutoDrive camera. Gate: complete *Don't Lose Your Mind* (any outcome) and receive a message from Delamain. | verified (web): https://www.cyberpunk.net/en/news/51674/update-2-3-patch-notes |
| Patch 2.31, 11 Sept 2025: AutoDrive drives smoothly to a selected point, overtakes blockers, no longer stops at lights; Free Roam follows traffic rules; the Delamain Cab fix "Johnny always spawned in the passenger seat" was corrected. | verified (web): https://www.cyberpunk.net/en/news/51794/patch-2-31 (summary via search; the item wording was read on a reprint, https://www.sportskeeda.com/esports/news-cyberpunk-2077-2-31-patch-notes-autodrive-upgrade-photo-mode-adjustments) |
| In the quest data the unlock is `sq025_done > 0` (the Delamain questline fact). The quest then sets `delamain_taxi_owned = 1` and runs an **EnablePlayerVehicle** node for `Vehicle.v_delamain_taxi` (`enable 1, makePlayerActiveVehicle 1, despawn 1`), sends the acquisition messages from phone contact `contacts/delamain_taxis` (`00_feature_acquisition/00a_delamain1_1`, `00a_delamain1_2`, a V choice group `01a_v`, and variants `00b/00c/02a/02b/02c` chosen by fact `sq025_delamain_fate` 1/2/3), and sets `delamain_first_ride = 1`. | verified (quest data), `delamain_taxi.questphase` |
| The same phase **disables** the cab again (`delamain_taxi_owned = 0`, EnablePlayerVehicle false) when V is inside the trigger area `#combat_zone_inside_tr`, then re-enables it. So no cab in combat zones. | verified (quest data) |
| Sources disagree on a "driver personality" choice at order time (https://www.playnews.gg/en/guides/cyberpunk-2077-patch-2-3-the-complete-guide-to-autodrive-delamain-rider-and-free-roam-driving-in-night-city, search summary only, the page itself returned HTTP 403). The scripts show no personality selection in the cab component or system. Treat as not real. | unverified (web, low trust) |

The mod already knows the contact: `characters/phone-contacts.json` line 53 lists contact `delamain_taxis` ("Delamain Cab") as unavailable for walking-companion chat ("a vehicle service"), next to the story Delamain contacts (`delamain`, `delamain_deep`, `delamain_manic`, `delamain_angry`, `delamain_mean`, `delamain_sad`, `delamain_suicidal`, `delamain_scared`), all marked unavailable.

### 1.2 Calling the cab (pickup)

The call is not a phone call. It is the garage summon:

1. V opens the vehicle summon menu (hotkey or radial). After the unlock, `Vehicle.v_delamain_taxi` is an enabled player vehicle, so it appears in the list as "Delamain Cab" (web, CDPR notes). The vehicle system exposes this as `VehicleSystem.EnablePlayerVehicle(String, Bool, Bool)`, `SpawnPlayerVehicle(...)`, `GetPlayerUnlockedVehicles(out array<PlayerVehicle>)` (verified (scripts), `core/systems/vehicleSystem.script`). That the menu entry is a garage entry follows from the component calling `VehicleSystem.UnregisterPlayerVehicle(recordID)` when the cab retires (verified (scripts)).
2. The cab spawns and drives to V (summon state `vehicleSummonState.EnRoute`, blackboard `VehicleSummonData`, the one the chauffeur already reads; verified (scripts) enum, used (repo) in `mod/companion-chauffeur-native.lua`).
3. When the cab entity attaches, `DelamainTaxiComponent.OnGameAttach` registers it: `InitState` sets state **Spawned (1)** if the persisted state is None, registers the entity for fact `delamain_taxi_state`, listens to the vehicle speed blackboard, and sets the door interaction states: front doors **Disabled**, back doors **Available**, trunk and hood Disabled (verified (scripts), `delamainTaxiComponent.script:38-58`).
4. When the cab parks, `OnVehicleParkedEvent` moves Spawned to **Parked (2)**; when speed is under 2 m/s in Parked, Arrived or Cancelled the back doors open (`OnVehicleSpeedChange`, verified (scripts)).
5. The quest phase waits for V to mount the cab (`questCharacterMount` condition), then plays the cab scene (section 2.2) whose first node writes **Ready (3)** (verified (quest data), scene node `delamain_taxi_state = 3` after the first-ride check).

Pickup is unavailable mid-mission or in scripted sequences (web: dtgre guide, low trust) and in combat zones (verified (quest data) above).

### 1.3 Destination, ride, arrival, payment

Verified (scripts) unless noted; files: `delamainTaxiComponent.script`, `delamainTaxiSystem.script`, `autoDriveSystem.script`, `worldMap.script`.

- **Destination.** On fact change to **Ready (3)** the component calls `UISystem.RequestDelamainTaxiMenu()`; the UI opens scenario `MenuScenario_DelamainTaxi` which switches to the **world map** in taxi mode (`DelamainTaxiSystem.IsDelamainTaxiEnabledOnMap()` true while it is open). V places a **custom position** (`TrackDelamainTaxiMappin`, mappin variant `Zzz20_DelamainTaxiDestinationVariant`); the pin has a generic title (localization key `UI-MappinTypes-DelamainDestination`), **no place name and no district** (`worldMapTooltips.script:505`). Every cursor move sends `SetTravelDestinationRequest(mappinID, cost)`.
- **Fare.** `GetTravelCost() = ceil(GetTravelDistance() / 500) * 50` eddies (`worldMap.script`; `GetTravelDistance` is a native map function whose metric, road or straight line, is unverified). Confirm is a hold action; it fails with an error animation if the cost exceeds V's money (`CanPay`).
- **Ride start.** Confirm queues `StartDelamainTaxiRequest(m_price)`. `DelamainTaxiSystem.OnStartDelamainTaxiRequest` calls `DelamainTaxiComponent.StartAutoDrive()`: state **Started (4)**, `EnableAutoDriveRequest{isDelamain = true}`, HUD context `UIGameContext.DelamainTaxi` pushed (HUD hidden, taxi input hints for cinematic camera and exit), `SetAllowPassengerCameraSwitch(true)`. `AutoDriveSystem.OnAutodriveToggled(true, true)` then sets quest facts `player_in_autodrive = 1`, `disable_combat_events = 1`, adds save lock `Autodrive`, and `SetFreeRoamEnabled(destinationType == None)`.
- **During the ride.** Native AutoDrive drives the vehicle; the cab has no NPC driver. Blackboard `UI_AutodriveData.AutoDriveDelamain` is true. 2.31 AutoDrive overtakes and ignores lights (web).
- **Arrival.** Native `StopAutoDriveOnDestinationReachedRequest` stops the car, unregisters the Delamain tracked mappin, queues `DelamainTaxiArrivedRequest`; `DelamainTaxiComponent.OnDelamainTaxiArrivedEvent` sets **Arrived (5)** and queues `PayTravelRequest`; a message is shown with a Delamain-styled warning banner. Back doors open once speed is under 2 m/s.
- **Payment.** `OnPayTravelRequest` does `TransactionSystem.RemoveItem(player, Money, m_currentTravelCost)` with no affordability check. It runs at arrival **and** whenever V steps out while the state is Started (`OnVehicleStartedMountingEvent` with `isMounting = false`). So leaving mid-ride still charges the full fare.
- **Cancel.** Backing out of the map menu calls `CancelDelamainRideRequest{forceExit = true}` (V is forced out through `ForceExitDelamainEvent`); `StopAutodriveIfNecessary` (health under `Vehicle.autodrive_settings.healthDeactivationThreshold`, vehicle quickhack, `sq024_race_active` lock, player leaving the seat) cancels with `forceExit = false`. Both set **Cancelled (6)** and remove the destination mappin.
- **After the ride.** The cab scene writes **Finished (7)** after the farewell. The quest phase then, if V is no longer waiting, writes **Freeroam (8)** (after about 5 s). On Freeroam the component sends `AIVehicleJoinTrafficCommand{needDriver = false, useKinematic = true}`, destroys its mappin and unregisters (`UnregisterCurrentTaxiRequest` unregisters the garage vehicle, back doors Disabled). **The cab then drives away into traffic.** A later mount by V on a retired cab forces V out (`isActiveCab` false).
- **Save and load.** The state persists in `DelamainTaxiComponentPS` (`m_state`); on load `InitState` resumes a Started ride (`StartAutoDrive()` again) and a Freeroam cab (`GoToFreeRoam`). The add-on must read the facts on session start, not rely only on events.

### 1.4 State machine (who writes each state)

| State | Value | Written by | Meaning for the add-on |
| --- | ---: | --- | --- |
| None | 0 | reset by `UnregisterCab`; also the pre-call value | no cab |
| Spawned | 1 | `InitState` on attach | **cab was called** (it exists) |
| Parked | 2 | `OnVehicleParkedEvent` | cab waiting at the curb, back doors open |
| Ready | 3 | the cab scene (quest data) | V seated; destination menu opens; greeting has played |
| Started | 4 | `StartAutoDrive` | **ride started** |
| Arrived | 5 | `OnDelamainTaxiArrivedEvent` | **ride ended** at the destination; fare charged; farewell scene |
| Cancelled | 6 | `CancelRide`, or the scene | **ride aborted** |
| Finished | 7 | the cab scene after the farewell | scene over; V may still be sitting |
| Freeroam | 8 | the quest phase | cab leaves into traffic |

### 1.5 Quest facts worth reading (all `QuestsSystem.GetFact(CName)`, verified (scripts); values verified (quest data))

`delamain_taxi_state` (0-8), `delamain_taxi_seat` (0, 1 back left, 2 back right; the component writes it only for back seats; `dpadHintItem.script:825` reads it), `delamain_waiting` (V is waiting in the cab, used by the phase and scene), `delamain_first_ride` (1 until the first ride's follow-up message), `delamain_skip_dialog` (set in the scene; the exact trigger is unverified), `delamain_taxi_owned`, `sq025_done`, `sq025_delamain_fate` (1, 2, 3: the story outcome, useful as persona background), `player_in_autodrive`, `disable_combat_events`.

### 1.6 Detection: event-driven names

All are `ObserveAfter` (or redscript wrap) on script functions; none runs per frame. The main mod already does this for AutoDrive in `mod/init.lua:2407-2418` (`ObserveAfter('AutoDriveSystem','OnAutodriveToggled', ...)` and `ObserveBefore('AutoDriveSystem','OnStopAutoDriveOnDestinationReachedRequest', ...)`), so the pattern is known-good for private script functions. "Live" below means a live probe with `DelamainTaxiComponent` has not been done: CET could in theory fail to hook a very small or inlined function.

| Signal | CET hook (verified (scripts) names) | Redscript alternative | Notes |
| --- | --- | --- | --- |
| **V called a cab** | `ObserveAfter('DelamainTaxiComponent','OnGameAttach', fn(self))`; the vehicle is `self:GetEntity()` (or `GetOwner()`). Cross-check the fact `delamain_taxi_state == 1`. | `@wrapMethod(DelamainTaxiComponent) private export function OnGameAttach()` | Also fires on a save load for a cab that exists. Weak extra signal: `VehicleSystem.SpawnPlayerVehicle` with the taxi record (native import; observing natives is unverified). |
| **Every state change** | `ObserveAfter('DelamainTaxiComponent','OnFactChanged', fn(self, evt))`, then `Game.GetQuestsSystem():GetFact(CName.new('delamain_taxi_state'))` (the component's own `SetState` writes the same fact and is registered through `QuestsSystem.RegisterEntity`, so its own writes also arrive here; scene-written states too). Fallback: observe `SetState`. | `@wrapMethod(DelamainTaxiComponent) protected event OnFactChanged(evt: ref<FactChangedEvent>) -> Bool` | One hook gives the whole table of 1.4. `OnFactChanged` returns early when `m_isActiveCab` is false. Unverified live: that CET delivers it. |
| **Ride started** | `ObserveAfter('DelamainTaxiComponent','StartAutoDrive', ...)` (public); or `ObserveAfter('DelamainTaxiSystem','OnStartDelamainTaxiRequest', fn(self, request))` with `request.m_price` as the fare | `@wrapMethod(DelamainTaxiComponent) public function StartAutoDrive()` | Also `AutoDriveSystem.OnAutodriveToggled(enabled, isDelamain)`: the main mod's existing observer ignores the second argument; the add-on should add its own observer and require `isDelamain == true`. |
| **Ride ended** | `ObserveAfter('DelamainTaxiComponent','OnDelamainTaxiArrivedEvent', ...)` (public) for arrival; `ObserveAfter('DelamainTaxiComponent','CancelRide', fn(self, forceExit))` (public) for cancel; `ObserveAfter('DelamainTaxiSystem','OnPayTravelRequest', ...)` for the fare charge | wrap the same three | Arrival is also visible as `ObserveBefore('AutoDriveSystem','OnStopAutoDriveOnDestinationReachedRequest', ...)` (already observed by the main mod; it needs `GetDelamainTrackedMappinID()` to tell a taxi stop from an ordinary AutoDrive stop). |
| **V is inside a Delamain cab** | On V's mount: `ObserveAfter('DelamainTaxiComponent','OnVehicleFinishedMountingEvent', fn(self, evt))` with `evt.character` equal to V, `evt.isMounting`, `evt.slotID`; or read `Game.GetQuestsSystem():GetFact(CName.new('delamain_taxi_seat'))` (1 or 2). State check on demand: `player:GetMountedVehicle():GetRecordID() == TweakDBID.new('Vehicle.v_standard2_villefort_cortes_delamain_player')` (the same record comparison pattern as the Mackinaw rule in `mod/companion-vehicle-native.lua:57`). | same hooks wrapped | `OnVehicleStartedMountingEvent` carries the same fields and also fires on exit (`isMounting` false), at which point the fare is charged if the state is Started. |
| **Destination** | `Game.GetScriptableSystemsContainer():Get('AutoDriveSystem'):GetAutodriveDestination()` (Vector3) and `GetAutodriveDestinationMappinID()`; the taxi pin is `Game.GetMappinSystem():GetDelamainTrackedMappinID()` then `GetMappin(id):GetWorldPosition()` | n/a | The chauffeur already reads these (`mod/companion-chauffeur-native.lua:189-300`, `U` wire section). Read once, at Started. |
| **Menu open or closed** | `ObserveAfter('DelamainTaxiSystem','OnDelamainTaxiMenuToggledRequest', fn(self, evt))`, `evt.isEnabled` | n/a | Tells the add-on that V is choosing a destination (stay quiet). |
| **Cab leaves** | `ObserveAfter('DelamainTaxiSystem','OnUnregisterCurrentTaxiRequest', ...)` or the fact reaching 8 | n/a | Last chance to release anything tied to the cab entity. |

RED4ext is not needed for detection. The events are script-level; the existing native chauffeur module already resolves `AutoDriveSystem`, `GetAutodriveIsDelamain` and the enums by RTTI (`docs/NATIVE_VEHICLES.md`; `docs/NATIVE_VEHICLES.md` records that `GetClass` knows native names only, and `AutoDriveSystem` is a script class with one name). A native hook would only be worth it if CET cannot hook `OnFactChanged`.

### 1.7 Seats and companion boarding

**The cab's seats (verified (scripts)).** The component names `EVehicleDoor.seat_front_left`, `seat_front_right`, `seat_back_left`, `seat_back_right`, `trunk`, `hood`, and the static helpers `VehicleComponent.GetBackLeftPassengerSlotID()` / `GetBackRightPassengerSlotID()`. So four seats. V sits in a back seat (the front doors are interaction-Disabled, so V cannot choose them). The driver seat `seat_front_left` stays empty: AutoDrive has no driver. The exact seat set of the record is unverified; `companion-vehicle-native.lua` `M.inspect` already reads it (`VehSeatSet():VehSeats()` plus `HasOccupantSlot`).

**Can a companion board? Evidence.**

- The cab component **ignores every mount event that is not V's** (`OnVehicleStartedMountingEvent` and `OnVehicleFinishedMountingEvent` return at once when `evt.character != player`). Nothing in `delamainTaxiComponent.script`, `delamainTaxiSystem.script` or `autoDriveSystem.script` reads other occupants. AutoDrive availability does not depend on passengers. (verified (scripts))
- The AI mount path: `ApproachVehicleDecorator` (`cyberpunk/ai/Tasks/aiVehicle.script:190-340`) opens the target seat's door with `VehicleComponent.OpenDoor(vehicle, slot)`, which just queues a `VehicleDoorOpen` request; `VehicleComponentPS.OnVehicleDoorOpen` opens the door unless it is `Detached` (`vehicleComponentPS.script:593`). **It never reads `VehicleDoorInteractionState`**, so the Disabled front doors block V's interaction prompt only, not an NPC's mount. (verified (scripts))
- Failure rules in that task: HLS `Alerted` fails it; a seat occupied by another entity for over 3 s fails it; vehicle speed above 0.5 fails it **except** for a player companion whose player is in the same vehicle, which gets `_teleportAfterApproach` success (`UpdateCompanionChecks`). So a companion can be put into a moving cab by the game's own logic. Whether the mod's companions count as `IsPlayerCompanion` is unverified. (verified (scripts) for the rule)
- An NPC already rides in a cab in the base game: the ambient-Johnny quest phase (`thepassenger.questphase`) has a branch for the cab record `Vehicle.v_standard2_villefort_cortes_delamain_player` with player role Passenger, and a pause condition on `delamain_taxi_state` together with `passenger_johnnyisaway` (verified (quest data); what it does with Johnny is read from node structure only). Patch 2.31 fixed his seating on cab rides (web). That is quest mounting, not the AI mount command, so it proves a seat can hold an NPC, not that `AIMountCommand` works.

**What could block it (ranked).**

1. **Timing.** The back doors close when V finishes mounting (`SetDoorState(false)`), the destination menu and the ride follow within seconds, and a ride-start leaves the door-approach task with a moving vehicle (speed above 0.5). Boarding must happen in the window between V's mount and the confirm, or before V sits (Parked state, doors open).
2. **Departure.** After arrival the cab keeps its doors open only while speed is under 2 and goes to Freeroam about 5 s after the farewell once V is out. A companion still inside rides away into traffic. The exit must start at **Arrived (5)**, not after V is out.
3. **Seat count.** 3 free seats, V holds one. Seats to offer: `seat_front_right` and the other back seat, so two companions. More would need overflow cars following a self-driving taxi.
4. **Door races.** The cab closes both back doors on V's mount; a companion walking to the other back door needs a fresh `OpenDoor` (the AI task sends one when within 0.1 m of the entry point).
5. **Scripted-vehicle checks.** None found: no `IsQuestVehicle`, no seat reservation by the component, no passenger kick for NPCs. Unverified live; this is the first thing to probe.

**How the existing boarding code applies, and what it would do unguarded.**

- `mod/companion-vehicles.lua` begins a journey when `api.player(player)` finds V mounted in any entity of type `Car` or `Bike` (`companion-vehicle-native.lua:27-35`); it checks no ownership. So **the Delamain cab is already treated as V's "primary" car**. `fill` assigns every free seat except `seat_front_left` in order front right, back left, back right (`companion-vehicles.lua:78,116-123`), and `allocate` then creates **overflow cars** behind the cab for any remaining companions (driver in `seat_front_left`, `AIVehicleFollowCommand` toward the cab, traffic on, only while the cab is nearly stopped). The overflow convoy is wrong for a taxi.
- Boarding itself reuses `M.mount` (`AIMountCommand` + `gameMountEventData`, `slotName = seat`, animated, failsafe teleport off) and `M.canBoard` (waits for combat and for HLS Alerted).
- `mod/companion-chauffeur-native.lua` selects "owned cars" by `IsPlayerVehicle()` and type `Car` (line 266); the cab is a player vehicle while it exists, so a chauffeur request near a parked cab could pick it. The chauffeur already treats `GetAutodriveIsDelamain()` as foreign (line 385), but the selection step should exclude the record explicitly.
- Fast travel and recovery code (`docs/COMPANION_RECOVERY_TRANSACTIONS.md`, vehicle-exit sections) unmounts and re-places companions with the existing placement checks; those apply unchanged after the cab leaves.

**Recommended guards for the add-on (to be built later, not now):**

1. Add a Delamain-cab predicate (record `Vehicle.v_standard2_villefort_cortes_delamain_player`, or `delamain_taxi_state ~= 0` with the record check) next to the Mackinaw special case, and let the fleet treat such a car as a **capped, no-overflow** car: at most the free non-driver seats, back seats preferred, no overflow spawn, no follow command.
2. Make the same predicate exclude the cab from chauffeur car selection.
3. Start boarding at **Parked (2) or Ready (3)** and stop starting new boardings at **Started (4)**; if a companion is mid-boarding at Started, let the native moving-vehicle rule decide.
4. Start the exit (`startExit('vehicle-change')` equivalent, animated unmount) at **Arrived (5)** or when V's `OnVehicleStartedMountingEvent` has `isMounting = false`, and before Freeroam; keep the existing stop and unmount ownership rules.
5. Treat a seat held by Johnny (ambient scene) as occupied (the allocator already does this through `seat.occupant`).
6. Read-only toward the cab: no `SetFact`, no `QueueRequest` to `DelamainTaxiSystem`, no command to the cab's AI component.

## 2. Delamain's in-game voice

### 2.1 Who

- **English actor: Samuel Barnett** (IMDb credits via search, GGRecon voice cast table, Sportskeeda): https://www.ggrecon.com/guides/cyberpunk-2077-phantom-liberty-voice-actors/ (fetched; Delamain row), https://www.sportskeeda.com/esports/news-cyberpunk-2077-voice-actors-the-faces-behind-characters-night-city. verified (web).
- **The GLaDOS personality is Ellen McLain** (https://www.dualshockers.com/cyberpunk-2077-how-to-find-portals-glados-in-night-city/, fetched). Local evidence agrees: the voice tag `delamain_glados` has 23 lines, all in the `sq025` scenes. verified (web) and (repo data).
- The cab's in-ride lines carry the plain `delamain` voice tag (file stem `delamain_delamain_taxi`: tag `delamain` plus scene tag `delamain_taxi`). That it is the same performer and the same processing as the story lines is an inference from the tag, not a listening result: unverified.

### 2.2 Where the lines are (installed English archives)

Found through SoundDB (`actor:delamain`, 541 lines; query via https://sounddb.zhincore.eu/v1/search/subtitles, 0-indexed pages) and matched to the repo's local WEM inventory (`runtime/voice-cast-inventory-20261001/{base,ep1}-wem-paths.txt`, which lists the same stems, with slightly different counts because it counts gender variants and holocall files). Archives: `archive/pc/content/lang_en_voice.archive` (base) and `archive/pc/ep1/lang_en_voice.archive` (Phantom Liberty). Stem pattern: `localization\en-us\vo\<voice tag>_<scene tag>_f_<hex id>.wem`; the numeric id is the subtitle StringID.

| Voice tag (stem) | Lines | Seconds | Where | Notes |
| --- | ---: | ---: | --- | --- |
| `delamain_delamain_taxi` | 12 (+2 male-variant files) | 36.9 | `delamain_taxi.scene`, quest `base\open_world\delamain_taxi\phases\delamain_taxi.questphase` | **The cab's own lines**: greetings (first ride and repeat), arrival announcement, farewells, "sit back and enjoy the views", "your wish is my command". All `Spoken`/`Community`, not phone. 1.2 to 5.5 s each. |
| `v_delamain_taxi` | 6 (+6 male) | about 6 | same scene | V's replies (casual hellos and goodbyes), not Delamain. |
| `delamain_scene_delamain_default` | 81 | 401.4 | `delamain_default.scene` (`base\quest\primary_characters\default_dialogues\`) | The Delamain **phone and default conversation** (research updates, hypotheses, questions to V, greetings "welcome back to the network", goodbyes). 79 of 81 are marked `Vo_Expression_Phone`. |
| `delamain_sad_scene_delamain_default` | 18 | 62.6 | same scene | Spoken lines in the "sad" voice tag, in-car and joyrider reactions. Personality variant: do not mix. |
| `delamain_sq025` | 72 | 352.7 | `sq025_*` (the Delamain questline) | main-story Delamain, 69 phone-expression lines. |
| `delamain_q203` | 57 | 254.3 | `q203_04_delamain.scene` | Act 2. |
| `delamain_q005` | 44 | 164.5 | `q005_02_cab_ride`, `q005_14_after_escape`, `q005_09_attack` | Prologue: the cab ride after the heist and the body-delivery call. |
| `delamain_q101` | 10 | 34.7 | `q101_05/06/07` | Act 1 rides. |
| `delamain_q307` (EP1 archive) | 41 | 194.3 | `q307_04_cabride.scene` | Phantom Liberty cab ride. |
| `delamain_sq012` | 3 | 16.6 | `sq025_06b_reward_holocall.scene` | Reward holocall. |
| `delamain_vs_vset_delamain` | 7 | about 15 | `vset_delamain.json` (voice set, no scene) | **Dispatcher-style phone framing**: "call accepted", "I'm here", "thank you for using the Delamain Network", call interrupted. Likely played on the Delamain phone contact; not confirmed for the vehicle-menu call. |
| Personality tags | about 14 variants | about 1,000 | `delamain_sad_{sq025,q203,q307}`, `delamain_deep`, `delamain_glados`, `delamain_manic`, `delamain_angry`, `delamain_scared`, `delamain_suicidal`, `delamain_distorted`, `delamain_merged`, `delamain_receptionist`, `delamain_receptionist_distorted` | Split-personality performances and the receptionist avatar. |

Plain-voice total (the eight rows from `delamain_scene_delamain_default` to `delamain_delamain_taxi`, personalities excluded): **320 lines, 1,455.6 s.** Only 15 of those are `Spoken`; the rest are `Vo_Expression_Phone`. `docs/VOICE_PHONE_CLIPS_2026-10-06.md` found that most phone-metadata lines are **not** band-limited in the stored audio (the game filters at run time), so they may still be usable references; the detector in `scripts/phone_detect/` decides per clip.

The main story and the "cab dispatcher" are not different voices: the dispatcher framing is the same `delamain` tag. The story Delamain also speaks inside the cab at other times (q005, q101, q203, q307 rides) but through quest scenes, not the 2.3 cab scene.

### 2.3 How this repo extracts references, and how to get clean Delamain references the same way (do not run yet)

Existing tooling (`docs/GAME_VOICE_REFERENCES.md`, `scripts/clip-search/`):

- `scripts/Extract-VoiceReferences.py`: RDAR archive reader (`Archive`, `depot_hash`), Oodle (`tools/redmod/bin/oo2ext_7_win64.dll`), SHA-1 check, subtitle reader. Bounded: a run is capped at 48 clips.
- `scripts/clip-search/missing-two/extract_two.py`: the exact template for a character without pool clips (8ug8ear, Jake Estevez, 2026-10-13). It takes a WEM-name prefix from the local inventory, reads each WEM from the archives (asserting exactly one archive holds it), takes the subtitle text from `research/cyberpunk/cache/game/localization/index/lookup.sqlite3` by StringID, decodes with `vgmstream-cli` (file output only, nothing played), and writes `<StringID>.wem/.wav/.txt`; then `analyze_two.py` (loudness, clipping, silence, ECAPA consistency), `asr_check.py` (Whisper transcript match) and `select_build.py` (duration-weighted leave-one-out ECAPA typicality, 1.5 to 9 s clips, at least 3 words, peak under -3 dBFS) build the omni-short, omni-long and Pocket sets. Reference budgets: Omni short 10 s, long 18 s (limit 20 s), Pocket 30 s (`scripts/clip-search/common.py`).
- `scripts/phone_detect/` flags band-limited clips; `scripts/Build-AutobestConfigs.mjs` writes the autobest configs (and would reset the key to `unprepared` if the pool has no clips, as `docs/GAME_VOICE_REFERENCES.md` warns).
- The pool index (`E:\CyberpunkConvai-offload\work\reference-picker\pool-index.json`, 92 voices) **has no Delamain voice**; `docs/VOICE_CAST_PREPARATION.md` states the 79-profile roster contains no Delamain profile. A new key (for example `delamain-cab`) and a character profile are needed.

Plan, same recipe:

1. Prefix list for the plain voice: `delamain_delamain_taxi_f_`, `delamain_scene_delamain_default_f_`, `delamain_sq025_f_`, `delamain_q203_f_`, `delamain_q005_f_`, `delamain_q101_f_`, `delamain_sq012_f_` (base) and `delamain_q307_f_` (EP1). **Exclude** every personality tag, `receptionist`, `distorted`, `merged`, and the `holocall`-folder file.
2. Tier A (cleanest, same acoustic setting as the add-on): the 12 `delamain_taxi` lines. Individually short (1.2 to 5.5 s); 8 of 12 are 1.4 to 3.1 s or under, so the 1.5 s and 3-word floor of the picker leaves roughly 7 usable clips; the longest set from them would be the whole 36.9 s, above the 18 s budget, so the picker chooses.
3. Tier B: phone-expression lines from q203, q307, q005, sq025 and the default scene (about 1,400 s), run through `phone_detect` first; take only spectrally full-band clips; prefer 4 to 9 s single-speaker statements.
4. Verify speaker by actor in SoundDB (`actor:delamain`, `voiceover:<stem>`) and by Whisper against the installed subtitle; verify no effect bus on the cab lines by spectrum (taxi lines are `Spoken`, not `Phone`, but a vehicle or hologram effect is applied at run time in unknown places: unverified).
5. Record statuses as the repo does (`metadata_found`, `extracted_and_local_transcript_verified`, `listening_verified`, `reference_approved`). Keep game text and audio under `runtime/` or the offload folder, never in the repo.

## 3. Ride context: what the AI could know mid-ride

"Event" means it can be captured from the hooks in 1.6 or an existing event; "turn" means one read when a turn is built (the main mod's `turn-context.lua` 5 s snapshot pattern, no per-frame work).

| Item | Source | Status | Cadence and caveats |
| --- | --- | --- | --- |
| Ride phase (called, parked, boarded, menu, started, arrived, cancelled, left) | `delamain_taxi_state` via `OnFactChanged` | verified (scripts + quest data) | event |
| Fare | `DelamainTaxiSystem:GetTravelCost()` (public const) and `StartDelamainTaxiRequest.m_price`; formula `ceil(distance / 500) * 50` | verified (scripts) | read at Started. Charged again as a full fare if V steps out early. |
| Destination position | `AutoDriveSystem:GetAutodriveDestination()`; taxi pin via `MappinSystem:GetDelamainTrackedMappinID()` | verified (scripts); the chauffeur already reads the same getters (verified (repo)) | once at Started |
| **Destination name or district** | none: the pin is a free custom position with a generic title | verified (scripts) that the game gives no name; **unverified** how to derive one | Options: a static district-centroid or polygon table from the repo's city data; or learn the district only on arrival (`GetCurrentDistrict()` after arrival). The prevention system's district stack only knows V's current position. |
| Current district and sub-area | `PreventionSystem:GetCurrentDistrict()` then `TweakDBInterface.GetDistrictRecord(id)`, parent walk | verified (repo: `mod/init.lua:567`, `currentDistrict()`) and (scripts) | turn |
| **Districts passed** | `ObserveAfter('PreventionSystem','OnDistrictAreaEntered', fn)` (`DistrictEnteredEvent{entered, district}`, private export) then `GetCurrentDistrict()`; keep a short ordered list | verified (scripts) function; CET hook unverified live | event; the route polyline itself is not exposed |
| Remaining distance and ETA | `AutoDriveSystem:GetDistanceToCurrentDestination()` and `GetEstimatedTimeToArrival()`; HUD floats `UI_AutodriveData.DestinationRemainingLength/Time` (the Delamain HUD widget is hidden) | verified (scripts); values near ride start may read 0 until the path loads (the chauffeur notes zero-initialised local path distance) | turn |
| Speed / moving | vehicle linear velocity as `companion-vehicle-native.lua` reads it, or blackboard `Vehicle.SpeedValue` | verified (repo/scripts) | turn (do not register a speed listener: it fires constantly) |
| Time of day | `Game.GetTimeSystem():GetGameTime()` | in `mod/turn-context.lua` (built, live check pending) | turn |
| Weather | `Game.GetWeatherSystem()` exists (`GameInstance.GetWeatherSystem`); the scripted `WeatherSystem` class has only `GetRainIntensityType()` (NoRain, LightRain, HeavyRain), `GetRainIntensity()`, `GetRainMoisture()`, `GetRainPuddles()` and a listener registration | rain: verified (scripts); **fog, smog, sandstorm and preset names: unverified** (no script getter; main's `turn-context.lua` `N.weather` tries `GetWeatherState` and three more names, none confirmed) | turn; reuse main's reader (merge `ea9a40fd`) |
| Traffic | no API; proxy: speed and AutoDrive stops | **unverified / not available** | do not promise "heavy traffic" from data |
| Police chase | `PreventionSystem:GetHeatStage()` (`EPreventionHeatStage` Heat_0..Heat_5) and `GetStarState()` | verified (scripts); main's `N.heat` reads it (live check pending). Note AutoDrive sets `disable_combat_events = 1` (verified (scripts)); whether a chase can start or continue during a ride is unverified | turn; cheap |
| Combat | `AutoDriveSystem` ignores combat state changes in Delamain mode (`OnPlayerStateChange` skips `GetAutodriveIsDelamain()`); V's combat flag as the mod reads it | verified (scripts) | turn |
| Cab damage | cab health stat pool vs `Vehicle.autodrive_settings.healthDeactivationThreshold`; a drop disables AutoDrive | verified (scripts) | event only if needed |
| First ride or repeat; Delamain's story outcome | `delamain_first_ride`, `sq025_delamain_fate` (1, 2, 3) | verified (quest data) | session start |
| Who else is aboard | the mod's own party and seat reads; seat held by ambient Johnny via `seat.occupant` | verified (repo) | turn |
| V's money (can afford) | the game's own `CanPay` is UI-side; `TransactionSystem` money read | main's `moneyBand` exists; cab use unverified | optional |

## 4. Conflict risks and rules

The main mod's rule: **game-placed characters are never driven by mod systems.** The add-on adds only a voice conversation about the ride. It does not command any NPC or the cab; the cab is a vehicle, and "Delamain" in it is a recorded voice plus a hologram effect in the quest scene (`delamain_holo`, `delamain_holocall_setup`, `delamain_holocall_lights` in the scene data), not a puppet. The following can still collide:

1. **The game's own cab dialogue.** The scene plays the greeting when V sits (before Ready), a first-ride variant, and the arrival and farewell lines (Arrived to Finished). The phase also runs a timed hand-off (about 5 s) before Freeroam. The add-on must not speak over these. Gate on the state table (silent in 2, 3 and 5 to 7 unless the scene is over), and on the main mod's existing subtitle hook `BaseSubtitlesGameController.ShowDialogLines` (`docs/GAME_DIALOGUE_CONTEXT.md`), which also lets the AI see what Delamain just said. Line type of the cab's lines (Regular, Holocall, Radio) is unverified; the hook drops `Radio` from a vehicle speaker.
2. **Same voice, two speakers.** The clone and the game's recordings use one voice: by design, but the player cannot tell which is the scripted one. Keep the add-on's lines clearly additive (no repeating the game's greeting) and keep the game's `delamain_skip_dialog` behaviour untouched.
3. **Ambient Johnny** may be seated in the cab and have his own scene. Two conversations at once: respect the main mod's existing rules for Johnny and the scene gate.
4. **Phone contacts.** `delamain*` contacts are listed as unavailable ("needs a drone companion"); `delamain_taxis` is the vehicle-service contact. The add-on's conversation should be a separate profile key and entry point (in the cab), not a switch-on of those walking-companion contacts.
5. **Main mod vehicle controller and chauffeur** (section 1.7): unguarded they board companions and spawn overflow cars, and the chauffeur might lease the parked cab.
6. **Save lock.** AutoDrive adds the save lock `Autodrive` for the whole ride; the add-on must not rely on saving mid-ride.
7. **Read-only.** No `SetFact`, no system requests, no vehicle commands; cab state is the game's.
8. **Budget.** The shared Convai key has a 100 turn/day cap per player (`TODO.md`, release schedule); ride chatter should be on demand or at the few state events, never periodic.

## 5. Prior art (URLs)

- CDPR patch notes 2.3 (Delamain Cab, AutoDrive): https://www.cyberpunk.net/en/news/51674/update-2-3-patch-notes (fetched).
- CDPR patch 2.31 (AutoDrive reworks, the Delamain Cab Johnny seat fix): https://www.cyberpunk.net/en/news/51794/patch-2-31 (found by search; the Johnny-seat item read on https://www.sportskeeda.com/esports/news-cyberpunk-2077-2-31-patch-notes-autodrive-upgrade-photo-mode-adjustments and https://vulkk.com/2025/09/11/cyberpunk-2077-update-2-31-changes-overview/, both via search summaries).
- CDPR modding documentation, script mirror (files fetched, 358 and 158 lines, matching the installed copies): https://github.com/CDPR-Modding-Documentation/Cyberpunk-Scripts/blob/main/scripts/core/components/scriptComponents/delamainTaxiComponent.script and https://github.com/CDPR-Modding-Documentation/Cyberpunk-Scripts/blob/main/scripts/core/systems/delamainTaxiSystem.script. The repo's vehicle doc pins another snapshot (`fce9ab7e6a60`, 2025-07-26).
- Redscript annotations (`@wrapMethod`, `@addMethod`, `@addField`, `@replaceMethod`): https://wiki.redmodding.org/redscript/language/annotations (fetched).
- CET `Observe`, `ObserveBefore`, `ObserveAfter`, `Override` (observers run before or after; Observe is an alias of ObserveBefore; works on all overloads): https://wiki.redmodding.org/cyber-engine-tweaks/cet-functions/observers (via search; the page was not fetched).
- NativeDB: https://nativedb.red4ext.com. It is a script-rendered app; the class URLs I tried (`/AutoDriveSystem`, `/DelamainTaxiComponent`) returned 404 and a search found nothing, so nothing here is cited from NativeDB. Check `DelamainTaxiComponent`, `DelamainTaxiSystem`, `AutoDriveSystem` there before building.
- Voice cast: https://www.ggrecon.com/guides/cyberpunk-2077-phantom-liberty-voice-actors/ (fetched), https://www.shacknews.com/article/137246/cyberpunk-2077-voice-cast, https://m.imdb.com/title/tt25808274/fullcredits (both via search), https://www.dualshockers.com/cyberpunk-2077-how-to-find-portals-glados-in-night-city/ (fetched; Ellen McLain).
- Voice line index: SoundDB, https://sounddb.redmodding.org/about, API spec https://sounddb.zhincore.eu/api.json; queries used: `actor:delamain`, `scene:delamain_taxi`, `voiceover:delamain_vs_vset_delamain`.
- Cab how-to guides (low trust, contradictory on dialogue and personalities): https://www.dtgre.com/2025/07/cyberpunk-2077-delamain-taxi-system-guide.html (fetched), the playnews guide above. Unlock-order guides for the questline: https://outsidergaming.com/cyberpunk-2077-complete-epistrophy-guide-and-delamain-cab-locations/, https://vulkk.com/2024/02/27/cyberpunk-2077-delamain-missions-walkthrough-with-all-endings/ (search results only).
- The Cyberpunk wiki (Fandom) returned HTTP 402 to the fetcher and was not used.
- I found no public mod that reads the cab state machine; only AutoDrive mods (for example https://www.nexusmods.com/cyberpunk2077/mods/14680, found by search, not opened).

## 6. Open questions and probe plan (all read-only; do not send game input)

Run through the existing diagnostic request route named in `TODO.md` ("read-only, through the existing diagnostic request file"); the user must be asked before any in-game test, per the standing workflow.

1. Does CET deliver `ObserveAfter('DelamainTaxiComponent','OnFactChanged')`, `OnGameAttach`, `StartAutoDrive`, `OnDelamainTaxiArrivedEvent`, `CancelRide`, and `ObserveAfter('DelamainTaxiSystem','OnPayTravelRequest')`? Log each with a timestamp and `GetFact('delamain_taxi_state')`.
2. Full ride trace: states 1 to 8 with times; which of them the scene writes (3, 7) versus the component; the real gap between V's mount and Started.
3. Mounted record id and the seat list from `M.inspect` for the cab; confirm `Vehicle.v_standard2_villefort_cortes_delamain_player` and four seats; confirm `Vehicle.v_delamain_taxi` is the garage id (TweakDB lookup).
4. Companion boarding on a parked cab: `AIMountCommand` to `seat_front_right` and the free back seat (Disabled front door), before V sits and during the greeting. Then the moving-cab case (does the game teleport the companion in, i.e. is the mod's companion an `IsPlayerCompanion`).
5. Arrival unmount: time from Arrived to the companion standing outside versus Freeroam; whether the cab waits.
6. Does the destination get a name anywhere (`GetMappin(...):GetDisplayName()` on the Delamain pin)? Choose the district-from-position method (static table versus other).
7. Weather beyond rain, `GetHeatStage()` during a ride, and whether the wanted level can rise while `disable_combat_events` is 1.
8. Line type of the cab lines in `ShowDialogLines`, and whether the greeting scene can be interrupted or skipped (`delamain_skip_dialog`).
9. Voice: spectrum of the 12 cab lines against the phone lines; listening check of tag `delamain_delamain_taxi` versus `delamain_q005` for identity.
10. Whether an old (pre-2.3) Delamain garage car coexists with the 2.3 cab entry in saves, and what the vehicle menu shows then.

## Appendix: how this was gathered

- Game scripts: `tools\redmod\scripts` (read), `r6\cache\final.redscripts`, `tweakdb.bin`, `tweakdb_ep1.bin` (string search for `delamain`; TweakDB name tokens `v_villefort_cortes_delamain`, `villefort_cortes__basic_delamain_taxi` and `sq025_delamain_cab` are present, the full record paths come from the quest data above).
- Quest data: `scripts/Extract-VoiceReferences.py` `Archive` and `Oodle` to read the three resources from `basegame_4_gamedata.archive`, then `vendor\wolvenkit-console-9.0.1\WolvenKit.CLI.exe convert serialize` into the session scratch folder. Nothing was written to the repo, the game folder or the archives. The scene resource was not played or decoded as audio.
- Voice index: SoundDB queries above and `runtime/voice-cast-inventory-20261001` (read).
- The weather, heat, health and money reads in main (`mod/turn-context.lua`, merge `ea9a40fd`) were read for reuse; their CET names remain unconfirmed in game.
