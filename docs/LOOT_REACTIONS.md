# Companion loot reactions

MCM **Settings → React to collected loot** defaults On. A nearby companion can
comment once after V finishes a batch of confirmed world pickups. This setting
is independent of battle reactions. Disabling it discards pending loot comments.

## Collection and ownership

`mod/loot-observer.lua` observes an item-specific native **Loot** interaction
before transfer and matches it to the player's nonsilent Added event. It verifies
the source, item identity and increase in quantity. Changed events update prior
ownership; they never produce a second receipt. Storage/vendor transfers veto
matching intents. Unknown, silent, scripted, currency and recipe grants stay
silent. Each receipt freezes exact companion entity/profile witnesses so another
copy of the same character cannot inherit an earlier pickup.

An inventory baseline and an ever-owned identity set distinguish newly acquired
equipment from equipment returned from storage or dropped and picked up again.
Incomplete native reads disable the new-equipment distinction. Native objects
never leave callbacks; bounded plain receipts are the policy's only input.

`mod/loot-reactions.lua` groups receipts and waits for six quiet gameplay seconds.
Pauses freeze that timer; batches expire after 90 wall-clock seconds. The ordinary
cooldown is ten minutes. Newly acquired Legendary, Legendary+, or Legendary++
weapons, clothing and cyberware can use a separate two-minute exception. A batch
contains at most 128 receipts and describes at most 12 items, keeping exceptional
equipment ahead of truncation. Save changes reset receipts, witnesses and cooldowns.

## One automatic reply owner

`mod/init.lua` coordinates battle and loot through the same request and playback
lease. Manual conversations and authored scenes have priority. An unavailable
speaker, renewed combat, expired request or disabled output cancels automatic
delivery. A temporary native bark may finish before AI playback starts, within
the original deadline; speech that interrupts an already playing line cancels it.

During an eligible battle closing, loot waits for the closing reply. If new
pickups are arriving, the closing waits for six quiet seconds, capped at 25
seconds after confirmed combat end and still within its original 40-second
admission window. The chosen witness receives only the items that copy witnessed.
The request freezes both snapshots; a successful dispatch consumes the captured
batch once. Newer pickups are not accidentally consumed. A closing starts both
loot cooldowns, including when it had no loot to describe. Other automatic events
are separated by 30 seconds; a battle's closing is exempt from its own opening.

The bridge validates the witness, bounds and computed equipment exception,
includes the actual item facts in the automatic trigger, and treats all item
labels as quoted game data. Prompts request a short statement without a follow-up
question and do not infer loot value, quest success, kills or victory.

## Verification and limits

The live September 30 diagnostic established:

- A world NiCola pickup: Added reports old quantity 0 and new item-data quantity
  1, followed by Changed +1.
- A prepared two-drink stack: Added reports old quantity 1 and new quantity 3,
  followed by Changed +2. These are one acquisition each.
- A vehicle-stash deposit and return: `VendorDataManager.TransferItem` identifies
  the vehicle source. The withdrawal is **not** flagged silent and produces the
  same Added/Changed shape as loot. Source exclusion is therefore required.

`npm run test:loot` covers the source sequences, batching, exact-copy witnesses,
cooldowns, cancellation, battle merging and wire validation. Fixture checks do
not qualify audible game behavior. Production installation and the first spoken
loot reaction are pending.

Only the observed item-specific Loot path is admitted initially. Corpse loot-all,
virtual pickups and acquisitions that emit Changed without Added are not yet
qualified; the observer reports unsupported coverage rather than guessing from
an inventory increase. Exploration observations remain a separate backlog item.

For live pickup checks, use `loot-test-drop:<nonce>` through the existing
diagnostics owner. It places exactly two test drinks at V's current feet using
the game's loot manager, preserving the previous quantity. The user requested
nearby test loot instead of having to search for a container. This route is
explicitly invoked only; normal gameplay never adds test items.
