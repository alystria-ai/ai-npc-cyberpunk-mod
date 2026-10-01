# Interrupted driver cleanup

## Purpose

CET Reload All Mods destroys the Lua owner even when the native driver is
still mounted. Removing that driver while V is a passenger can trigger the
game's automatic switch into the driver seat. The reload cleanup owner retains
only authority to finish an interrupted exit and remove the old mod copy.
It does not restore the party, resume AutoDrive, recreate a waypoint, invite
an actor, call Convai, seed memory, or create a player identity.

`mod/companions.lua` owns the helper and calls the policy in
`mod/companion-reload-cleanup.lua`. `mod/init.lua` loads the disk receipt during
initialization; native validation and exit work occur later in normal gameplay.

## Receipt and native proof

The ignored runtime file `companion-chauffeur-cleanup.json` contains one
version 2 `cleanup-only` receipt. It records the exact player, actor and borrowed
car IDs as strings, their records, the driver seat, a command receipt when
present, a unique cleanup tag, a bounded attempt count, and a one-hour expiry.
It contains no voice/profile/provider session, conversation, destination or
memory data. Reads are capped at 4,097 bytes; writes cannot exceed 4,096 bytes.

The shutdown capture proves the copy is currently managed by Codeware and has
the mod's common companion tag. It assigns a fresh unique native tag and reads
back exactly one matching tagged ID. Recovery obtains native `EntityID` values
from that unique tag enumeration. It never converts a serialized UInt64 through
a Lua number, scans the world's NPCs, or selects a character by display name.

Every active recovery checks:

- The current player binding and a ready dynamic entity system.
- Exactly one entity with the unique tag, matching the receipt's actor ID.
- Actual native `IsManaged` plus both common and unique `IsTagged` checks.
- An attached, non-crowd NPC with the exact record and an `AIFollowerRole`.
- The exact borrowed, player-owned vehicle and its record, obtained from a
  native mount parent, a previously validated native ID, or the real summoned
  vehicle blackboard.
- The actual driver mount belongs to that car and the front-left driver slot.

The unique tag is part of the nonpersistent dynamic copy's native state.
Codeware clears its native registry at world detach, and these copies have
`persistState=false` and `persistSpawn=false`. A save load or new game therefore
cannot turn a stale disk receipt into authority over a different actor. The
mod's save/death/detach abandonment also erases the receipt and drops references
without reading or mutating native components.

## Exit sequence

Recovery is completely dormant while V occupies any seat of the borrowed car,
including its driver seat. It does not mount, unmount, teleport, eject, reseat or
otherwise control V. Once V is outside:

1. Confirm another AutoDrive journey has not taken control. A matching active
   journey may receive up to three native disable requests. There is no enable
   path in this module.
2. Wait for a car speed of at most 0.25 m/s. At most three borrowed-car brake
   requests can be issued; a native scene or combat blocks exit work.
3. Reacquire only the exact previous `AIMountCommand` or `AIUnmountCommand`
   receipt on this copy. A live handler must still name the same car and
   driver slot. A foreign class, command, vehicle or slot is rejected.
4. Retire the old mount command before sending an animated `AIUnmountCommand`
   through the existing native vehicle adapter. An active unmount is allowed
   to finish; it is cancelled only after the actual seat link clears or its
   bounded timeout. Its receipt is persisted for another CET reload.
5. Confirm no actual mount remains, the owned command is terminal, the exit
   workspot has ended, and the car's driver slot no longer reports this actor.
6. Delete only that exact proved dynamic companion. The player-owned car is
   never passed to a deletion API. After an accepted actor deletion, poll only
   Codeware registry metadata because the native components may be detaching.

Native polling is limited to two updates per simulation second. Paused frames
do not advance retries. Unmount attempts are capped at three and persisted
across CET reloads; command retirement has a 12-second bound. Receipt expiry,
failed proof or exhausted retries ends the automatic authority without trying
a forced exit or deleting an uncertain actor.

## Legacy interrupted copy helper

An old CET instance did not write a receipt. For an already seated legacy mod
copy, a reviewed diagnostic may pass the exact native actor to:

```lua
local accepted, reason = companions.captureInterruptedDriver(npc)
local state = companions.reloadCleanupSnapshot()
```

The helper checks current native ownership and common tag, an attached matching
entity/record, its follower role, an actual driver-seat mount, and the exact
owned car. Only then does it assign/read back the unique tag and persist the
cleanup receipt. It never adds that actor to the new party or adopts the old
trip. A tagless, unmanaged, quest, ambient, wrong-seat or foreign-car actor
cannot be handed off through this helper. Root diagnostics should obtain the
native actor/ID from the common tag or another already validated native handle,
not fabricate an ID from a numeric string.

## Failure and verification boundaries

Capture returns failure when native proof or receipt persistence fails. The
shutdown log records that failure/pending reason, and driver dismissal stays
blocked by the live trip owner. It must not be reported as completed cleanup.
A failed progress write also stops the automatic authority; no forced fallback
is sent. The unique tag alone does not authorize party restoration.

`bridge/companion-reload-cleanup.test.mjs` executes the real Lua policy and its
native adapter with explicit registry, mount, command, scene and storage
fixtures. It covers V-aboard dormancy, wrong/stale receipts, unique-tag proof,
exact command binding, UInt64 handling, native exit timing, bounded retries,
and accepted-deletion polling that forbids retired component reads.

These checks establish source behavior. Live acceptance still requires a
parked owned car, a proved driver copy, V's manual exit, an observed animated
driver exit, and confirmed removal of that copy without a player seat change.

## Native source used

- Codeware `scripts/World/DynamicEntitySystem.reds`: `GetTaggedIDs`,
  `AssignTag`, `IsManaged`, `IsTagged`, `GetEntity`, `DeleteEntity`.
- Codeware `src/App/World/DynamicEntitySystem.cpp`: native tag registry,
  nonpersistent entity save filtering, and registry clearing on world detach.
- Installed Cyberpunk 2.31 `core/ai/actions/aiActionHelper.script:687-694`:
  `WorkspotSystem.IsActorInWorkspot`.
- The mod's existing `companion-vehicle-native.lua`: mount parent IDs,
  seat inspection, exact command receipts, terminal-state cancellation and
  animated unmount options.
