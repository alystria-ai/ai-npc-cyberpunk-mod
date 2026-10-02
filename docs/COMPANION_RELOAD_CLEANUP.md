# Retained driver cleanup after CET reload

CET reload can retire the Lua owner while a companion remains seated or a borrowed car still has a native driving command. This subsystem persists **cleanup authority only**. It never restores the party, starts/updates driving, recreates a waypoint or moves V.

## Receipt

The ignored runtime file `runtime/companion-chauffeur-cleanup.json` contains a bounded, one-hour receipt. New receipts use version 3 and `backend='npc'`; existing version-2 AutoDrive receipts remain readable for retirement.

The receipt identifies:

- The actual player entity, managed/tagged driver, NPC record and uniquely assigned cleanup tag.
- The borrowed owned-car entity/record and actual front-left driver slot.
- A driver's outstanding `AIMountCommand` or `AIUnmountCommand`, if present.
- The lead car's `AIVehicleDriveToPointAutonomousCommand` **separately**, including its post-send UInt32 ID and retirement attempts.
- Bounded unmount/deletion progress.

It contains no conversation profile, memory ID, destination, driving intent, actor handle or AI-component reference. The unassigned ID `4294967295`, unrelated command classes, expired/future/oversized data and malformed IDs are rejected.

UInt64 entity identities are not round-tripped through doubles. Native IDs come from Codeware's exact unique-tag enumeration, actual mounts or the summoned-car blackboard.

A file alone cannot authorize cleanup. Every pass rechecks the unique native cleanup tag, managed ownership, normal companion tag, actor record/follower role, exact borrowed owned car and actual seats. Deleted entities are polled only through registry metadata.

## Retirement order

1. Wait for a valid gameplay world and reprove the actor/car binding. Pauses do not advance cleanup.
2. Reacquire a fresh vehicle-AI handle only when its class/ID matches the stored car-command receipt. Never adopt a replacement or class-wide command.
3. Retire the exact car command, including while V is still a passenger. Scene/foreign/V-driver guards remain active. No new route is submitted.
4. Retain its plain fixed-car stop obligation even after native terminal state. A coasting car must receive guarded braking **before** passenger-wait; native command completion is not stopped evidence.
5. Once the car is physically stopped, retain the driver while V occupies any seat. Never eject or switch V.
6. When V is outside, retire an outstanding NPC mount handler or allow a legitimate animated unmount to finish. Confirm the actual driver seat and exit workspot have cleared.
7. Remove only the uniquely proved old managed driver. The borrowed player car is never deleted.

If V drives, a scene takes control, a foreign AI/AutoDrive journey owns the vehicle, or a different driver occupies the slot, cleanup does not brake that owner. It retains its receipt and waits. A foreign AutoDrive journey is never disabled by a new NPC-backend receipt.

Version-2 receipts may retire their already-proved legacy AutoDrive lease through the old guarded disable adapter. They do not grant authority over a newly observed vehicle-AI command.

## Attempts and failure

Retirement uses the native Bool result and fresh command state. Refusals/exceptions before acknowledgment have at most three exact-ID submissions; accepted pending retirement is not resent. A terminal observation reconciles a throw after its side effect. The attempt count survives reload.

Vehicle-command warning timeout does not erase the active receipt or license driver deletion. A terminal vehicle command remains recorded until safe stopped evidence, including when V is still a passenger. Braking and NPC unmount attempts have separate bounded allowances.

No NPC exit or deletion occurs while a car is moving, an owned command is nonterminal, a native exit workspot remains active, or control is unverified. Transient unavailable probes remain pending; a definitively changed player/tag/record binding rejects the receipt. Save/death/world abandonment makes no native calls and invalidates transient cleanup authority.

An accepted driver despawn is polled without resubmission or reads through retiring actor components. There is no companion respawn or trip resume on ordinary save reload.

## Integration

`companions.prepareChauffeurShutdown` passes both the driver's mount operation and the car's driving operation to the cleanup capture. The trip remains protected until normal teardown finishes. An explicit handoff of an already interrupted legacy seated copy requires the same native ownership proof; it does not add that copy to the current party.

`companion-vehicle-native.lua` supplies exact command receipt/rebinding and animated NPC mount/unmount operations. `companion-chauffeur-native.lua` supplies the current driving observation, exact vehicle-command retirement and guarded braking. The recovered owner is retirement-only.

## Verification

`bridge/companion-reload-cleanup.test.mjs` covers receipt validation, unique-tag/native binding, exact mount/vehicle-command recovery, coasting with V still aboard, scene/V-driver/foreign-control guards, bounded retirement and unmounting, delayed despawn and world abandonment. `bridge/chauffeur-game-integration.test.mjs` exercises the real companion wrappers and protected old-driver cleanup.

The bounded live native driving trial qualifies command movement and bindings. Version-3 production reload retirement and its physical stop/exit behavior remain an installed gameplay check after the combined update is activated.
