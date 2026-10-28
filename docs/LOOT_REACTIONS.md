# Companion loot reactions

Companion Manager **Settings → React to collected loot** is **on by default since 2026-10-26**; a player who had turned it off keeps it off
(a saved off counts only when the player chose it; an unchosen saved off moves to on once).
A nearby companion can comment once after V finishes a batch of confirmed world
pickups. This setting is independent of battle reactions. Turning it off discards
pending loot comments.

## Cost on the Convai free tier

Ordinary loot comments are ten minutes apart; newly acquired Legendary gear gets its own spacing of two minutes. On the shared Convai key each
comment counts as one of the day's 500 turns, like any other turn (there is no share of the day set apart for reactions since 2026-10-28), and once the day's allowance is used up nothing is spent and the comment is skipped silently. The Loot interaction hook reads the pickup's action first and captures its context (battle sample, witnesses) only for a Loot action on another character, so a door or a lift costs nothing extra. The three inventory hooks (item added, changed, removed) fire for every item event, and a crafting, disassembly or vendor burst is hundreds of them in one frame: with the setting on (the default since 0.3.2) each asks V's puppet whether it is the local player only once per frame (`localPlayer` in `mod/loot-observer.lua` keeps the answer for the frame, keyed on `convaiHeartbeat.frame`, and forgets it on a reset or a new update), so an event costs about five native reads instead of about twelve; with the setting off they return before any native call.

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
Incomplete native reads disable the new-equipment distinction until a clean
full inventory read. Native objects
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

A pickup comment and a battle opening are separate spoken turns, and a pickup
comment with no fight is a standalone turn. The pickup policy keeps its own
six-second quiet window, 90-second pending limit and exact-copy witnesses; only
dispatching a reaction that carries a frozen snapshot can consume its prefix or
start a loot cooldown, and later acquisitions stay outside that prefix. After a
fight, the closing and the pickups are one reply (below).

The shared owner admits one request/audio/caption turn at a time. Once that owner
is released, a different reaction type can follow after about two seconds,
instead of the previous thirty-second spacing. The same battle's closing can
also follow its opening. Per-feature cooldowns and original admission deadlines
still apply.

**One reply after a fight (October 5).** Pickups V collected during the fight or
before the closing request is written travel *in the closing request*: one
request, one speaker, one short spoken reply (at most two sentences, thirty words)
covering the end of the fight and what was picked up. Details:

- The closing speaker is chosen among eligible witnesses, preferring one who also
  saw the pickups, then the usual rotation. The pickup facts are that exact copy's
  (`mergeable`/`attach`/`claimMerged` in `loot-reactions.lua`); a pickup only another
  witness saw is not carried and keeps its own comment.
- While the fight is being confirmed over, ready pickups do not speak on their own;
  the closing is only a few seconds away.
- A closing normally goes out four seconds after combat is confirmed over. If a
  pickup is still being collected (inside the six-second quiet window) it waits for
  the pickup to finish, but never longer than fourteen seconds after combat was
  confirmed over (its own window is forty). Then it goes with whatever is pending.
- Carried pickups count as commented: they are consumed and start the same
  cooldowns a standalone comment would (ten minutes; two for new Legendary
  equipment). Pickups still under cooldown are not carried and the closing does
  not wait for them.
- A pickup made **after the closing request was written** (generating or playing)
  is a separate pickup comment under the normal rules: after the closing releases
  the shared owner and a two-second pause, once its own quiet window passes.
  If the closing carried pickups, the cooldown they started keeps later ones silent.
- Mid-fight pickups are carried too (they are simply pending when the closing
  goes out); this was trivial with the same mechanism and avoids a loot line
  followed twenty seconds later by "the fight is over".
- Cancellation is the closing's: a conversation key, an opened menu, a scene, an
  unavailable speaker or renewed combat cancels the merged request and its pickups
  are not replayed.

An opening, and a pickup comment with no fight, are unchanged. The bridge accepts a
pickup batch only on a closing that names that exact batch.

An unavailable battle witness does not reserve the channel against another eligible
pickup witness. Manual conversation and authored scenes still take priority; a
conversation cancels only the comment it interrupts, and a queued pickup comment
plays once afterwards if its own ninety-second window is still open.

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
cooldowns, cancellation, the then-current battle merging and wire validation. September 30:
110 checks pass; the optional installed-MCM integration check also passes when
run separately against the game's actual API files. The source checkpoint is
`ac609bc`. Fixture checks do not qualify audible game behavior.
The combined Lua update was installed and hash-verified at 01:00 IST on
September 30; the conversation bridge was restarted with the new context code.
CET activation was confirmed from the new globals, registered hooks and complete
321-item inventory baseline. The user collected the prepared two-drink stack
and confirmed hearing a loot comment. The live trace recorded one quantity-two
receipt at 01:03:23 IST, one Judy reaction after the six-second collection wait,
a successful result at 01:03:36 and completed playback at 01:03:41. No duplicate
reaction was generated. Evidence is retained locally in
`runtime/loot-first-audible-20260930.json` and the matching `.log`.

Storage provenance is captured and has regression coverage; the Legendary
exception still needs live acceptance. The combined battle/loot behavior was
replaced on October 1 by the separate-turn policy described above. The
previous installed adapters are backed up under
`backups/loot-equipment-before-20260930-010043/`.

Only the observed item-specific Loot path is admitted initially. Corpse loot-all,
virtual pickups and acquisitions that emit Changed without Added are not yet
qualified; the observer reports unsupported coverage rather than guessing from
an inventory increase. Automatic exploration observations remain inactive; this
change does not add an unreliable speech or exploration trigger.

## Separate-turn verification — October 1

Executable tests exercise the actual coordinator with simultaneous closing and
pickup eligibility, ongoing collection, long owned playback, different exact
witnesses, a native-busy battle witness, expired closing windows, combat-state
dips and manual/save interruption. The October 1 policy kept the two comments
fully separate; October 5 replaced that for the end of a fight with the single
merged reply above. Ordinary manual messages may carry both types of factual
context. These checks verify queue/prompt ownership; live audible acceptance is
pending installation.

For live pickup checks, use `loot-test-drop:<nonce>` through the existing
diagnostics owner. It places exactly two test drinks at V's current feet using
the game's loot manager, preserving the previous quantity. The user requested
nearby test loot instead of having to search for a container. This route is
explicitly invoked only; normal gameplay never adds test items.

## Legendary pickups — October 5

Source audit of the Legendary path:

- **Quality is the game's own name.** `RPGManager.GetItemDataQuality(data)` is
  what the game's item-added notification and loot UI read
  (`itemsQueue.script`, `looting.script`). Its enum text was confirmed live
  (`gamedataQuality : Common (0)`); Legendary, Legendary+ and Legendary++ are
  matched by name. In the game's scripts the Plus tiers and Iconic are separate
  item stats (`GetItemPlus`, `IsItemIconic`), so such items normally arrive as
  `Legendary`; Iconic is not treated as Legendary.
- **Reaction.** Quality is a fact, not an instruction. Every pickup gives the
  speaker each item's display name, type, quality and, where readable, its
  inventory tooltip description (see below), and the speaker reacts naturally. The
  bridge no longer tells the speaker to say an item is Legendary; Legendary only
  decides the cooldown exception.
- **Type.** The observer reads `gameItemData:GetItemType()` (for example
  `Wea_AssaultRifle`) as an optional descriptive field. An unreadable or
  malformed value is dropped and never rejects a pickup; the category is the
  fallback. This getter has not yet been exercised live.
- **Cooldown.** Unchanged and still as the MCM text states: newly acquired
  Legendary weapons, clothing and cyberware bypass the ten-minute cooldown, with
  their own two-minute spacing. A Legendary mod or other category speaks under the
  ordinary cooldown but is still described as Legendary. A second Legendary
  batch within two minutes of the first is not commented on.
- **New-equipment detection no longer dies for a session.** Incompleteness
  recorded a missed event (a failing callback, an unreadable item, an unavailable
  player interval) and stayed set until save change, which silently demoted every
  later Legendary pickup to the ordinary cooldown. A clean full inventory read now
  clears it; the ever-owned set persists across reads, and a failure inside that
  read or an overflowing set still keeps it off.
- **Diagnostics.** `runtime/probe.log` records each accepted receipt with its
  quality, category, type and new flag, and each automatic loot request with item
  count and exception flag, so a missing comment can be traced to detection,
  cooldown or delivery.

## Item description text — October 5

Each accepted pickup also carries the item's inventory tooltip description when it
can be read. The inventory builds it as `LocKeyToString(itemRecord.LocalizedDescription())`
(`inventoryDataManagerV2.script:1711`, `InventoryItem.script:1020`); the same
`Item_Record` has `DisplayName()` for the name the observer already reads.
`LocalizedDescription()` returns a `CName` key (`tweakDBRecords.script:5236`), and
`LocKeyToString`, `GetLocalizedTextByKey` and `GetLocalizedItemNameByCName` are
imported localization functions (`uiTextUtils.script:1-13`). The observer reads the
key from the record and tries those resolvers in order, accepting the first
non-empty text that is not an unresolved `LocKey#`. This exact read has **not** been
exercised in the live game yet (the repository's live-verified neighbours are
`UIItemsHelper.GetItemName` and `Game.GetLocalizedTextByKey` on vehicle records).
Markup and control characters are removed, whitespace collapses, and a text longer
than 280 characters is cut at a sentence (else word) end without splitting a
character. An unreadable or empty description is left out and never rejects a
pickup. The prompt carries descriptions for the first five items only. The text is
quoted game data, never instructions.

Still excluded, unchanged: corpse loot-all, virtual pickups and Changed-only
increments (no verified native provenance), storage, purchases and quest grants.
A comment is cancelled, not deferred, if V opens a menu before it is audible.

## Source audit — October 4

That day the coordinator gave combat closing and collected loot separate
sequential turns, with mixed automatic payloads rejected. October 5 superseded
this for the end of a fight: a closing may carry the batch it names.

The native delivery adapter exposes `battleObserver.canDeliver(player,
npc, phase)` to refresh the player's scene/call/vehicle and combat state as well
as the speaker before starting an automatic line. The ordinary half-second
poll is insufficient at this boundary: a scripted conversation may begin after
that poll but before the prepared reply arrives. The shared coordinator uses it
in `reactionCanDeliver`. A temporary autonomous NPC bark remains a waitable
condition, while a player scene or renewed combat cancels the pickup comment.

The Legendary exception remains restricted to a verified new equipment identity,
complete inventory coverage, a nonsilent Added event, and matching item-specific
world provenance. Storage transfers, purchases, unknown/silent grants, Changed-only
increments and unqualified corpse loot-all remain excluded. This audit made no
live inventory changes, provider requests, or claims of new audible acceptance.
The remaining checks are actual sequential battle/loot playback and a real new
Legendary pickup; unsupported event routes require native provenance evidence
before implementation.
