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

Combat and pickups produce **separate spoken turns**. A battle closing never
captures or consumes a pickup batch, starts a loot cooldown, or waits for loot
collection to finish. The pickup policy keeps its own six-second quiet window,
90-second pending limit and exact-copy witnesses. Only dispatching its own
standalone reaction can consume the captured prefix or start a loot cooldown;
later acquisitions stay outside that prefix.

The shared owner admits one request/audio/caption turn at a time. Once that owner
is released, a different reaction type can follow after about two seconds,
instead of the previous thirty-second spacing. The same battle's closing can
also follow its opening. Per-feature cooldowns and original admission deadlines
still apply. If battle closing and a quiet pickup batch become eligible together,
closing normally takes the shorter-window slot first; the pending pickup gets its
own next turn. A pickup already eligible earlier may speak before closing. An
unavailable battle witness does not reserve the channel against another eligible
pickup witness. Manual conversation and authored scenes still take priority.

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
dips and manual/save interruption. Battle and loot automatic payloads reject
mixed contexts at the bridge boundary. Ordinary manual messages may still carry
both types of factual context. These checks verify queue/prompt ownership; live
audible acceptance of the new separate-turn behavior is pending installation.

For live pickup checks, use `loot-test-drop:<nonce>` through the existing
diagnostics owner. It places exactly two test drinks at V's current feet using
the game's loot manager, preserving the previous quantity. The user requested
nearby test loot instead of having to search for a container. This route is
explicitly invoked only; normal gameplay never adds test items.

## Source audit — October 4

The shared coordinator already gives combat closing and collected loot separate
sequential turns. Their payloads reject mixed automatic contexts, and a battle
turn cannot consume the pickup queue or its cooldown. No extra merging or
parallel playback path is needed.

The native delivery adapter now exposes `battleObserver.canDeliver(player,
npc, phase)` to refresh the player's scene/call/vehicle and combat state as well
as the speaker before starting an automatic line. The ordinary half-second
poll is insufficient at this boundary: a scripted conversation may begin after
that poll but before the prepared reply arrives. The shared coordinator must
use this method in its delivery check; its integration is owned by the root
task. A temporary autonomous NPC bark remains a waitable condition, while a
player scene or renewed combat cancels the pickup comment.

The Legendary exception remains restricted to a verified new equipment identity,
complete inventory coverage, a nonsilent Added event, and matching item-specific
world provenance. Storage transfers, purchases, unknown/silent grants, Changed-only
increments and unqualified corpse loot-all remain excluded. This audit made no
live inventory changes, provider requests, or claims of new audible acceptance.
The remaining checks are actual sequential battle/loot playback and a real new
Legendary pickup; unsupported event routes require native provenance evidence
before implementation.
