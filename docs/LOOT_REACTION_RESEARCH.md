# Loot acquisition evidence and diagnostic probe

The bounded research probe `mod/loot-probe.lua` observes inventory
and source-bearing calls; it does not implement a reaction or classify an
inventory increase as fresh loot. It makes no Convai requests, changes no items,
save data or native behavior, retains no native references, and writes no files.
It is not loaded by `init.lua` and is disabled until explicitly started. The
production collector and reaction policy are documented in `LOOT_REACTIONS.md`.
September 30 live world-pickup, stack and vehicle-storage evidence is summarized
there; the remaining unverified routes below stay excluded by the collector.

## Parent diagnostic integration

Load the module through the existing diagnostics owner when a live evidence test
is appropriate. No redscript or restart is required for this Lua observer:

```lua
local probe = dofile('loot-probe.lua')
probe.install()                       -- Register observers; capture stays off.
local started = probe.start({seconds = 120, maxEvents = 512})
local receipt = probe.status()        -- Plain detached table; parent may save it.
local final = probe.stop('finished')  -- Preserve captured evidence; stop reading.
```

`start` resets the previous capture, clamps duration to 1–300 seconds and caps
events at 512. Capture stops at its limit, wall-clock expiry, player detach or
death. Expiry is evaluated before every callback and status read. Registered
observers remain inert after stopping and repeated installation avoids duplicates.
The probe does not poll, register an update loop, or write the diagnostic request
file. The parent remains the only live request-file owner.

Each receipt reports registration attempts and actual active callback counts
separately. CET accepting a registration does not prove that a method fires on
this installed game. Event order uses a monotonically increasing `sequence`;
`at` is wall-clock milliseconds with one-second source resolution. `delta` is
the native event's raw `difference`, not a normalized acquisition count.

Unknown reads are the literal `unavailable`, including source/success where an
event supplies neither. In particular, false `flaggedAsSilent` is preserved;
the changed/removal event contracts do not expose that flag. Item combined hash,
record and random seed are captured separately. Native objects, errors and
controller references are not included in receipts.

## Verified source contracts

References are Git-object paths under `vendor/reference-game-scripts@HEAD`;
the sparse checkout may require `git show HEAD:<path>` to read a file.

| Evidence | Source | What it establishes |
| --- | --- | --- |
| Added / changed / removal events | `scripts/core/events/inventoryEvents.script:5–27` | IDs, data, quantity/difference; source owner is absent. Added has the silent flag. |
| Player handlers | `scripts/cyberpunk/player/player.script:2361,2451,3629` | Existing hooks for inventory changes. |
| Equipment slot handlers | `scripts/cyberpunk/player/player.script:2201–2216,2295–2313` | `GetItemID` / `GetSlotID`; these are equipment events, not proof of acquisition. |
| Stable item identity APIs | `scripts/core/data/itemID.script:11–18` | Record, combined hash and random seed can be read without retaining the native ID. |
| Stack-aware listener alternative | `scripts/core/components/inventoryComponent.script:1–11`; `scripts/core/systems/transactionSystem.script:89–91` | `OnItemQuantityChanged` includes diff, total and silent flag. Requires a listener class; not installed by this Lua probe. |
| World loot choice | `scripts/core/components/inventoryComponent.script:96–141` | Owner, activator, item ID and action from `LootChoiceActionWrapper`. Intent requires inventory confirmation. |
| Loot-all signal | `scripts/core/components/inventoryComponent.script:35–41,89–94` | Event has no item/activator payload; handler only plays a sound. It is a batch hint. |
| Corpse loot-all | `scripts/cyberpunk/puppet/scriptedPuppet.script:3622–3647` | `Loot` interaction transfers from that puppet to the activator. |
| Virtual pickup | `scripts/cyberpunk/items/virtualItem.script:39–49` | `VirtualItem_TEMP.OnInteractionChoice` grants with `GiveItem`, so a transfer-only observer would miss it. |
| Storage single/quantity transfers | `scripts/cyberpunk/UI/fullscreen/vendor/fullscreenVendorGameController.script:789–826,1039–1048`; `scripts/cyberpunk/UI/data/vendor.script:273–277` | Source, target, item and amount are explicit. The wrapper does **not** set the silent flag. |
| Apartment and vehicle storage | `scripts/cyberpunk/devices/stash/stash.script:108–131`; `scripts/core/components/scriptComponents/vehicleComponent.script:4088–4100` | Storage can be a stash object or a vehicle. `IsPlayerStash()` alone misses the vehicle route. |
| Buy versus buyback intent | `scripts/cyberpunk/UI/data/vendor.script:208–243` | Separate request methods; UI request events are not proof of success. |
| Successful vendor operations | `scripts/cyberpunk/systems/marketSystem/vendor.script:1003–1075` | Successful buys and buybacks both emit `UIVendorItemsBoughtEvent`; retain originating request classification. Not captured as success by this probe. |

## Feasible production design after evidence

1. Establish an inventory baseline on save attach. Fuse add/change notifications
   by resulting quantity to avoid double-counting; prove callback ordering first.
2. Correlate actual increases with a bounded source ledger. Exclude confirmed
   storage withdrawals and buybacks. Keep purchases distinct from world loot.
   Unknown provenance remains unknown; never infer location or defeated owner.
3. Rebaseline during suppressed states. Ignore equip/part operations and
   nonpositive increases. Record only bounded plain descriptions and witnesses.
4. Let a quiet window finish the batch. Use native looting UI activity as a hint,
   not proof of collection. Consume a post-fight batch once into the battle
   closing reply to avoid a second automatic comment.

The game's existing activity-log filter (`player.script:2523–2527`) excludes
silent events, `SkipActivityLog`, `SkipActivityLogOnLoot`, currency, preview IDs,
ordinary recipes, broken items and workspot additions. It also uses
`UIItemsHelper.GetItemName`. Reuse verified player scene/call/dialogue-choice and
manual-conversation gates before requesting or playing any automatic reaction.
Inventory activity occurring during a scripted conversation must not become a
surprise delayed loot comment afterward.

Use named quality values, not enum ordering:
`scripts/core/data/tweakDBEnums.script:336–352` includes Legendary,
LegendaryPlus and LegendaryPlusPlus in a non-rarity ordering. The native loot UI
reads `RPGManager.GetItemDataQuality`, `RPGManager.IsItemIconic` and item-plus
separately (`scripts/cyberpunk/UI/interactions/looting.script:643–665`). A rare
equipment exception should track prior ownership as well as quality so upgrades,
storage returns and repeated pickup of the same item do not look like discovery.

## Dawnwalker 0.5.5 reference

Within `vendor/reference-dawnwalker-0.5.5/Dawnwalker/Binaries/Win64/ue4ss/Mods/DawnwalkerConvai/Payload/mod/Scripts/`:

- `loot_comments.lua:37–61` baselines inventory/storage and subtracts storage
  withdrawals from increases. Unknown storage forces rebaselining.
- `loot_comments.lua:52–79` bounds batches to 12 descriptions, waits six quiet
  seconds and defers during combat/cinematic dialogue.
- `battle_comments.lua:165–175` waits for a batch, then consumes it into the
  closing response.
- `reaction_policy.lua:15–23,50–57` controls ordinary/rare cooldowns and prevents
  another loot reaction immediately after the combined battle closing.

These are design references, not evidence of Cyberpunk event semantics.

## Focused live evidence still required

Compare a world pickup, loot-all, apartment/vehicle storage withdrawal, vendor
purchase/buyback and equip/reload. Verify actual CET callback coverage, ordering,
stack behavior, item identity after dropping/re-picking, and whether storage
notifications can arrive after its menu closes. A positive inventory event plus
a nearby interaction is only correlation until these paths are observed. Mods,
quest grants and scripted inventory restoration may bypass the captured methods.

No live test or installation is implied by the fixture checks. The bounded test
is `node --test bridge/loot-probe.test.mjs`; it verifies disabled observers,
pass-through behavior, plain detached receipts, event/expiry limits, failed-read
handling and source distinctions without touching the game.
