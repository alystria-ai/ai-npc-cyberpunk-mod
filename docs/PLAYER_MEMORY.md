# Player memory

## Current policy

One persistent Convai `endUserId` belongs to this local player. Every named
character and every conversation channel uses that ID. Loading another save,
reloading CET, restarting the bridge, and either Forget action retain it.

Selecting **Invite** prepares the character's verified mod-owned memory
configuration, prepares its selected voice, then warms its connection. The NPC
appears only after those steps complete. Preparation enables and checks the profile's memory settings; it
does not create saved memories or add the character to the contacted registry.
Characters build provider memory naturally from actual conversations. The
first player message records contact and reuses the prepared verification, so
the prepared connection stays warm. A player send without an invitation verifies
the configuration before sending.

Spawning, reading quests, and evaluating automatic battle/loot triggers never
add a character to the contacted registry. An actual admitted automatic reply
does record its character locally, so **Forget all** covers characters that have
spoken even when the player has not sent them a manual message. That bookkeeping
does not enable memory or send an extra provider request. Convai may naturally
extract memory from real conversations; this runtime has no `/memory/add`,
quest-seeding worker, save-identity component, branch archive, or pool of provider
IDs.

Generic NC Resident profiles represent templates rather than unique pedestrians.
Transient sessions distinguish their entity IDs, but provider memory is attached
to the resident profile and player ID, not to each pedestrian's physical body.

## Persistence and current game context

`runtime/player-memory.json` holds the player ID, contacted profiles, reset
epochs and confirmed-action outcomes. `runtime/player-memory.json.identity`
anchors the same ID. Keep **both files** across updates and backups. They are
ignored by Git. The `.lock` file allows one writer; corrupt or disagreeing
established files stop routing instead of silently replacing the player.

Lua publishes a fresh world token after restore/detach. The bridge cancels prior
turns and transient sessions; it never changes the player ID. Reviewed current
facts and revealed journal objectives are supplied as dynamic context. They are
authoritative about the loaded game; remembered conversations can refer to an
earlier save and do not establish which quest choices happened now.

Private, phone and each exact group audience have separate transient sessions,
also separated by world token and reset epoch. Text and microphone input share
their private/group session and the connection prepared at invitation time.
Provider LTM remains shared for the same player/character.
Session separation does not promise separate private/group provider memories.

## Forget controls

**Companion Manager → Settings → Memory** provides a searchable character picker,
**Forget selected character**, and **Forget all memories**. An inline confirmation
is required. The selected displayed character is a family of its configured
ordinary and relationship provider variants. A character clear targets all
contacted provider pairs in that family, including retained historical pairs.
All targets only locally recorded contacted pairs; it does not issue deletions
for the rest of the catalogue.

Before deletion, durable reset epochs invalidate old replies and local provider
sessions close. Each target names the exact player/provider-character pair and
checks an empty provider list afterward. The aggregate succeeds only when all
its targets are confirmed and transport work has quiesced. A partial, timed-out
or inconclusive result remains failed and keeps the affected family fenced until
a new explicit clear succeeds. Restarting the bridge never repeats a deletion.

Success means an empty list was observed. Convai's asynchronous extraction has
no documented flush barrier, so this does not guarantee that an earlier server
job cannot finish afterward. Natural recall and a real Forget action still need
live acceptance with this installed flow.

### Matching phone Chat cleanup

Phone Chat retains its complete local history and unsent drafts across launches,
save loads and CET reloads. There is no disappearing-message option or automatic
launch cleanup.

- A successful **Forget selected character** removes that family's matching Chat
  messages and drafts only after its aggregate provider reset is confirmed.
- A successful **Forget all memories** removes all local Chat messages and drafts,
  including archived data, only after the complete aggregate reset is confirmed.
- A failed, cancelled or uncertain reset preserves local history and drafts.
  Pending resets cancel affected requests; delayed replies and cached native
  editor text cannot restore data removed by a successful reset.
- An empty contacted set can authorize local cleanup without enabling, deleting
  or inspecting an unused provider pair. The UI must authorize the configured
  character family. Every Forget action retains the persistent player ID.

The control owner records a reset intent before cloud dispatch, then publishes
successful receipts in `runtime/memory-chat-resets.json`. Lua remains the sole
writer of `phone-history.json`: it removes the matching data and records the
action tombstone in one replacement. Repeated receipts do not delete newer
conversations. A missed confirmed result is reconciled locally after restart
without another provider deletion. A failed local receipt/history write holds
affected phone sends until persistence succeeds; it does not turn partial cloud
success into permission to erase the shared Chat.

See [CHAT_MEMORY_RESET.md](CHAT_MEMORY_RESET.md) for family/alias handling,
archives, durable request epochs and storage-failure recovery. A character's ordinary profile
and its Multilingual twin retain separate provider memories (the former romantic
profiles are gone, so the relationship setting never splits memory); their
displayed local Chat is shared by character.

## Vendor memory

A shopkeeper V returns to remembers V ("a ripperdoc remembers V") across game
sessions and loads. Every other unnamed NPC stays session-only: generic NPC
archetypes (`npc-*`) are ambient profiles with Convai long-term memory off.

**Why local.** Convai memory is per (character, end user), and this runtime
deliberately has exactly one end-user ID (see above). Giving each shop its own
provider memory would need one ID per shop, and the shared archetype character
would mix all ripperdocs together. So vendor memory is a small local store that
is handed back as dynamic context each turn. It makes no provider call and
creates no Convai ID; `bridge/player-memory.mjs` identity logic is untouched.

**Identity key.** The TweakDB record of a one-shop vendor, which the game sends
as `archetype.memoryKey` (for example `wat_kab_ripperdoc_01`; generated by
`mod/character-catalog.lua` from the catalogue's `vendorRecords`, parsed by
`parseArchetype` in `bridge/protocol.mjs`). The key must match
`^[a-z0-9_]{3,64}$` (case-insensitive, stored lower-case) and the archetype
category must be `vendor`. A record is a real place, so the same ripperdoc is
recognized across saves, sessions and body swaps, and two ripperdocs never share
a memory. Crowd NPCs, gang and faction members, shared street-stall records and
invited Model-browser copies carry no key and are never stored. If a record ever
maps to a different archetype profile, its stored memory is not used and starts
over.

**What is remembered.** After a private text or voice reply has been heard
to the end (the game's native or continuous playback receipt, the same one
that confirms delivery to the knowledge router), the player's words and the
vendor's reply are stored as one exchange. Not remembered: battle, loot and
other automatic reactions, group rounds, phone chat, replies that were
cancelled, interrupted, stale or never heard, turns whose world or reset guard
is no longer current, and the `[Microphone]` placeholder (a voice turn is stored
by the recognized words, and skipped when no transcript exists). A turn with
Voice playback switched off has no playback receipt, so it is not stored.

**Where and limits.** `runtime/vendor-memory.json` in the state directory
(`{version: 1, vendors: {<key>: {profileKey, updatedAt, exchanges: [{at, v, npc}]}}}`;
ignored by Git and never packaged).

- last 10 exchanges per vendor, oldest dropped first;
- each side clipped to 300 characters;
- at most 200 vendors, the least recently updated evicted first;
- a file larger than 2 MiB is not read; a write that would exceed it first
  evicts the oldest vendors;
- writes are serialized and atomic (temp file plus rename, the shared
  `guarded-file.mjs` helper), and the final rename re-checks the turn's world
  and reset guard in the same tick;
- a corrupt or oversize file starts the store empty and is kept as
  `runtime/vendor-memory.json.corrupt`; nothing ever throws into the
  conversation, and a failed write only means that exchange is not remembered.

**How it is used.** For a private text or voice turn of such a vendor, the
bridge adds a section "WHAT YOU REMEMBER OF V (earlier talks at this shop)" to
the per-turn context (next to the archetype context in `conversationContext`),
listing the stored exchanges oldest first. It frames them as the vendor's own
memory to use naturally and never recite, states that old exchanges are not
facts about the current game state, and that the vendor still knows nothing of
V's story beyond what V said. It contains no real dates. The section is left out
whenever the turn is not an admitted current turn (for example while a Forget is
pending).

**Forget.** **Forget all memories** also clears the vendor store. Order inside
one accepted Forget all:

1. `PlayerMemory` persists the new reset epoch and fences every character. From
   this instant every turn that started earlier has a permanently stale guard,
   so it can neither read nor write vendor memory.
2. Its quiesce step runs: live turns, pages and sessions are closed
   (`resetLiveRoutes`), then `VendorMemory.forgetAll()` empties the in-memory
   store immediately, discards every queued write, and removes the file and any
   `.corrupt` copy. If removal fails, the quiesce fails and the Forget reports
   "Old conversations could not be closed. Memories were not cleared" before any
   provider deletion; confirming again retries.
3. Only then are the provider memories deleted per contacted character, followed
   by the local Chat cleanup.

A conversation that starts after the Forget has a fresh guard and is remembered
again. **Forget selected character** does not touch vendor memory: unnamed NPC
archetypes are not in the character picker, and a "Shopkeepers" entry would need
new interface strings in every locale, so Forget all memories is the way to clear
what shopkeepers remember. `VendorMemory.forgetVendor(key)` exists for a future
per-shop control. Both Forget actions retain the player ID.

`VendorMemory.status()` reports counts only (vendors, exchanges, whether a
damaged copy is kept), never text. Tests: `bridge/vendor-memory.test.mjs`.

## Implementation and checks

- `bridge/player-memory.mjs`: durable identity, invitation preparation,
  conversation admission and clears.
- `bridge/player-memory-api.mjs`: verified ownership and bounded Core API calls.
- `bridge/player-knowledge.mjs`: fresh current-world and audience routing.
- `bridge/player-phone-knowledge.mjs`: immutable phone request/session ownership.
- `bridge/player-memory-control.mjs`: native Companion Manager command/result IPC.
- `bridge/vendor-memory.mjs`: local per-shop memory (see Vendor memory).
- `bridge/chat-memory-resets.mjs`: confirmed aggregate reset journal and local
  reconciliation.
- `mod/phone-chat.lua`: history/draft cleanup, receipt tombstones and late-reply
  guards.
- `mod/init.lua`: Lua world lifecycle and bounded game knowledge collectors.

Run `npm run test:memory` for the core, provider fixtures, routing, IPC, isolated
real bridge startup and native MCM framework checks. These tests use local
fixtures and make no production provider requests. API details and limitations
are in `research/cyberpunk/PLAYER_MEMORY_API.md`; native UI behavior is described
in `docs/PLAYER_MEMORY_UI.md`.

Earlier September 30 coordinated verification: **926 tests passed, zero failed or
skipped**, including the installed MCM API framework fixture and the real bridge
startup with provider/browser/GPU side effects trapped. The realtime browser
bundle also built successfully. A separate read-only production check confirmed
Judy's exact profile ID, ownership marker and memory-settings schema. At that
checkpoint, before invitation preparation was added, memory remained disabled
until her first actual message. These checks do not establish rendered UI
acceptance, natural recall or a real Forget result.

That earlier coordinated update was installed and hash verified. The running bridge
reported a matching player identity anchor and fresh ready Memory status, with
zero contacted characters before the first actual message. Cyberpunk was
launched for the user check; visible menu, reply and recall acceptance remains
pending. Main feature checkpoint: `a361f13`. Invitation preparation described
above was subsequently installed in `9290ab3`: 983 checks passed, copied Lua and
catalogues were hash verified, and the restarted service reported ready memory
with the same identity anchor and one existing contacted character. Cyberpunk
was launched. Judy subsequently joined after the user closed the manager, and
her first F6 send reused the prepared page/SDK with 7.8 ms memory admission and
about 4.9 seconds to native playback. The user also accepted the separate Memory
page and Back to settings; detailed evidence is in `docs/COMPANION_INVITATIONS.md`.

`prepareCharacter({profileKey, guard?, signal?})` checks the exact durable registry
and identity anchor, then shares the same bounded enable flight and in-process
verification cache as `beginConversation`. Its frozen result contains
`endUserId`, `guard`, `memoryEnabled`, `memoryEnabledNow`, `changed`, and
`reconnectRequired`. The obligation remains pending even if all waiting callers
cancel after a shared enable completes. The transport owner disposes the old
character routes, then calls `acknowledgeConnectionRefresh({profileKey, guard})`
before warming a replacement. A later first actual player send records contact and returns
`memoryEnabledNow: false` and `reconnectRequired: false` for that prepared state.
Cancelling one caller leaves other shared callers running; explicit clear and
close abort shared verification and invalidate old guards. Preparation itself
does not write the registry, issue a memory-data request, or seed provider LTM.

The later family-aware Chat reset integration has separate offline evidence in
[CHAT_MEMORY_RESET.md](CHAT_MEMORY_RESET.md). Those tests use isolated registries,
storage and provider fixtures; no real player's memories or messages are cleared.
