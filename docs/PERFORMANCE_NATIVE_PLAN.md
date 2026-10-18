# Performance plan: hot Lua paths and the native route

Written 2026-10-12. FPS is the top priority: even a 2-3 FPS loss is unacceptable, and the mod adds no per-frame
main-thread work it can avoid. This document ranks where the CET Lua spends the game thread's time, says which
route each hot path should take (a Lua fix, redscript, or a C++ RED4ext native), and gives the order of work.
C++ is not the goal in itself; fewer milliseconds per frame is.

Units: **ms/s** is milliseconds of game-thread time per second of play. At 44 fps (22.8 ms frames), 44 ms/s
is 1 ms per frame. When the game is limited by its main thread, removing 1 ms per frame at 44 fps is worth
about 2 FPS (44 to 46); at 60 fps it is worth about 4 FPS.

## 1. Evidence

**Live probe, 2026-10-12** (the fixed probe from `2821b31`, on HEAD's `mod/` as of `c7daf0c`: the first three
quick wins and the context work installed; `perf-probe-capture-20261012.json`, 67 two-second windows,
10:12:09-10:14:21 UTC). Read it for what it is. It does **not** hold the planned 8-minute run (quiet, street,
walking, voice chat). Matched against `probe.log`, it covers a fresh session: about 28 s before a save load
(windows 1-14, 58.6 fps, menu or loading likely), the load itself (windows 15-19, frames up to 426 ms), then
about 94 s in game (windows 20-66): Alex summoned at 10:13:14, one **typed** reply at 10:13:28 that spoke
for about 6 s (3 windows). There is no walking and no voice turn. The `perf-live-20261012.json` copy is
byte-identical to the 2026-10-08 `perf-live-final.json`, so it is stale and not used.

In game (windows 20-66, 94.5 s): 48.4 fps mean, 20.7 ms mean frame, 503 frames over 25 ms and 59 over 40 ms.

| Section (in game, 94.5 s) | Calls/s | ms/s | ms/call | Max ms |
| --- | --- | --- | --- | --- |
| **`event:onUpdate` (the whole callback)** | 48.4 | **179.4** | 3.70 | 144 |
| `worldKnowledge.update` | 48.4 | **58.1** | 1.20 | 26 |
| `io.open` (all files, nested) | 12.5 | 24.5 | 1.95 | 21 |
| `mcm.update` | 48.4 | 19.2 | 0.40 | 64 |
| `speech.update` | 48.4 | 15.6 | 0.32 | 19 |
| of which `face.updateExpressions` | 48.4 | 10.2 | 0.21 | 19 |
| `journalHistory.update` | 48.4 | **11.3** | 0.23 | 16 |
| `phoneChat.update` | 48.4 | 9.1 | 0.19 | 15 |
| `os.rename` (nested) | 1.7 | 6.1 | 3.61 | 6 |
| `invitations.update` | 48.4 | 5.9 | 0.12 | 15 |
| `companions.update` (10 Hz) | 7.7 | 4.9 | 0.63 | 22 |
| `relationshipState.update` | 48.4 | 4.8 | 0.10 | 14 |
| `phoneChatStyle.refresh` | 48.4 | 4.4 | 0.09 | 63 |
| `manager.update` (10 Hz) | 9.1 | 3.9 | 0.43 | 22 |
| `json.encode` (nested) | 54.5 | 2.8 | 0.05 | 81 |
| `autoConnect.update` + `heartbeat` | | 4.7 | | 15 |
| `json.decode` 4-32 KB (nested) | 1.1 | 2.2 | 1.97 | 5 |
| `gameplayActions.update` (10 Hz) | 9.1 | 1.6 | 0.18 | 7 |
| `os.remove` (nested) | 1.7 | 1.4 | 0.81 | 2 |
| everything else wrapped | | < 3 | | |

What it says:
- **The mod's Lua takes 3.7 ms of every 20.7 ms frame: 18 % of the game thread.** If the game is limited by
  its main thread, that is about 10 FPS (48 to 58). It is the first measurement of the whole callback.
- **The knowledge collectors are the largest single cost: 69 ms/s (worldKnowledge 58.1 + journalHistory
  11.3), 1.43 ms per frame, every frame,** 39 % of the callback. They ran at the same rate before the save
  load (66 ms/s in windows 1-14). Removing 90 % of it is worth about 3.4 FPS at 48 fps.
- **File IO is second: 32 ms/s** (`io.open` 24.5 + `os.rename` 6.1 + `os.remove` 1.4), 0.66 ms per frame.
  By file, per second: `memory-chat-resets.json` read 1.8, `companion-actions.json` read 1.5,
  `diagnostic-request.txt` 1.0, `face-test-request.txt` 1.0 and `gesture-probe-request.txt` 0.8 (these two
  are development-only), `local-voice-state.json` 0.6, then one each per 2 s for `speech-state`, `reply.json`,
  invitations, party, nearby (`.tmp` + rename), relationship (`.tmp` + rename), world-session,
  invitations-state and `bridge-service`, plus `probe.log` and `mcm.log` appends (0.3 each).
- **init.lua's own unwrapped work in `onUpdate` is about 34 ms/s** (the callback minus its top-level wrapped
  sections, about 145 ms/s). It holds the nearby and relationship renames and other inline polls.
- `mcm.update` is about 5 ms/s at rest after `cc9d911`; the 19 ms/s mean comes from windows 48-51
  (87-278 ms/s, frames up to 64 ms), most likely with the MCM page or pause menu open.
- The face writer cost 10.2 ms/s with one companion before `cf1cdda` (the idle sleep, item 4).
- **The Lua heap swings between 22 and 46 MB** in game, with a GC drop in half the windows: at least
  1.7 MB/s of allocation. Collection cost lands in whichever section triggers it.
- **Hooks are still unmeasured:** there are `event:onUpdate` rows but no `hook:` rows, although
  `probe.log` shows the game-dialogue hooks firing. Every hook registers inside `onInit`, and CET can bind
  its own `Observe`/`Override` again there; `49f89b8` re-wraps them at the start of each `onInit` handler and
  records `hooksWrapped` per window, so the next capture shows whether the wrap took.
- 23 of the 47 in-game windows have their worst frame mostly inside `onUpdate` (onUpdate max over 60 % of
  the frame max). The other half are stalls outside the mod's Lua.

**Live probe, 2026-10-11** (`<mod>/runtime/perf-probe.json`, 150 two-second windows, 302 s). Developer mode on,
one idle companion (Alex, holding), nobody speaking, phone and menus closed, 43.8 fps mean, 23.0 ms mean frame.
15 % of frames were over 25 ms and 3.6 % over 40 ms; the median window's worst frame was 56 ms.

| Section (wrapped by the probe) | Calls/s | ms/s | ms/call | Max ms |
| --- | --- | --- | --- | --- |
| `io.open` (all files) | 9.0 | 27.6 | 3.06 | 32 |
| `speech.update` (per frame) | 43.8 | 25.9 | 0.59 | 62 |
| of which `face.updateExpressions` | 43.8 | 21.9 | 0.50 | 62 |
| `os.rename` | 3.2 | 15.1 | 4.78 | 13 |
| `phoneChat.update` (per frame) | 43.8 | 13.6 | 0.31 | 62 |
| `mcm.update` (per frame) | 43.8 | 12.9 | 0.29 | 72 |
| `companions.update` (10 Hz) | 8.8 | 7.6 | 0.86 | 68 |
| `invitations.update` (per frame) | 43.8 | 6.5 | 0.15 | 38 |
| `companions.conversationCandidates` | 45.0 | 4.5 | 0.10 | 2 |
| `os.remove` | 3.2 | 3.8 | 1.19 | 6 |
| `json.encode` | 48.4 | 3.4 | 0.07 | 26 |
| `face.beginExpressionFrame` | 43.8 | 2.0 | 0.05 | 6 |
| `json.decode` (<4 KB) | 44.1 | 1.4 | 0.03 | 61 |

File IO is nested inside the sections, so the rows do not add up. The top-level sections alone come to about
71 ms/s, 1.6 ms per frame. Not measured at all: the world-knowledge and journal collectors, every CET
Observe/Override hook, and init.lua's own local work in `onUpdate` (see 1.1).

**Earlier evidence.**
- 2026-10-08, before that day's fixes: the user measured 55-60 FPS with the mod's Lua stubbed and 25-30 with it.
  The probed sections then added up to only 6-7 ms per frame. That points at work the probe could not see.
- 2026-10-08, while Judy spoke: `speech.update` measured 426-461 ms/s and FPS fell from about 50 to 19-21.
  Commit `041e57b` cut that file traffic.
- 2026-10-08 (`perf-live.json`): `json.encode` peaked at 72 ms in one call. That was the per-turn request
  (section 2, item 1).

**Measured costs of the CET boundary in this install:** one `io.open` costs about 3 ms, `os.rename` about
4.8 ms and `os.remove` about 1.2 ms. A native call into the game costs roughly 10-25 µs. So a single file
operation costs as much as 150-300 native calls.

### 1.1 The probe could not see hooks (fixed in two steps)

`init.lua` loads `perf-probe.lua` twice: `hookRegistrations` at the top, `install` after the modules. The
second chunk got its own `enabled` flag, so every `hook:Class.Method` and `event:onUpdate` wrapper made by the
first chunk never recorded. That is why the 2026-10-11 capture has none of those rows.

Commit `2821b31` fixes this: a second load returns the first chunk. It also times the following, so
`event:onUpdate` minus the sections leaves only init.lua's own local work:
- the rest of the per-frame top half: `ui.update`, the composer, phone layout and style, auto-connect;
- the 10 Hz `manager`, `tactics`, `microphone` and `movementLog` updates;
- `worldKnowledge.update`, `journalHistory.update` and `relationshipState.update`.

The 2026-10-12 capture then had `event:onUpdate` rows but still no `hook:` rows. Every hook registers inside
`onInit`, where CET can bind its own `Observe`/`Override` again; `49f89b8` re-wraps them at the start of each
`onInit` handler and records `hooksWrapped` per window.

It also records the Lua heap (`luaKB`) per window. 65 of the 150 windows hold a frame over 60 ms with no mod
section near that, which looks like a shared stall: a GC step, the file system or antivirus, or a game hitch.

### 1.2 What this install measures that players do not run

The user's development install also runs `face-test.lua` and `gesture-probe.lua`. Each polls a request file
once a second, about 3 ms each. Developer logging and the movement trace are also on. Releases exclude both
probes (`packaging/release.config.json` `devOnlyLua`), so players pay a little less than the numbers above.
`perf-probe.lua` ships but stays inert unless Developer mode is on.

## 2. Ranked hot paths

**Order by measured cost, 2026-10-12** (in game, one companion, section 1). Item numbers stay as first
written, since commits and `TODO.md` cite them.

| Rank | Item | Measured ms/s | Per frame at 48 fps | Route |
| --- | --- | --- | --- | --- |
| 1 | 1: knowledge collectors | **69** | 1.43 ms | **Done (`843a527`):** they rest between scans and rescan on a journal change or before a turn; turns name the parts by revision (`4b9ff83`, `5c4d870`). Pending the next capture; C++ collector only if still over ~5 ms/s |
| 2 | 15: init.lua's own `onUpdate` work | ~34 (unattributed) | 0.70 ms | Segment timers in Developer mode (`9057812`, `init:` rows); four native calls per frame removed (`4dcc8e4`). Fix what the next capture shows |
| 3 | 2: file IO, all files | 32 | 0.66 ms | Lua cuts done (`cb96750`, `471de62`, `01d93c2`: about 3.5 opens/s fewer, heartbeats one per frame); the C++ async IO (`31d7ea5`, needs the plugin) removes the rest |
| 4 | 4: face writer | 10.2 | 0.21 ms | **Done (`cf1cdda`)**, pending the in-game check |
| 5 | 6: phone chat | 9.1 | 0.19 ms | **Done (`cb96750`):** no per-frame JSON round trip; the reset journal is read every 5 s with no chat open |
| 6 | 8: invitations | 5.9 | 0.12 ms | Lua: its remaining per-frame work |
| 7 | 5: MCM at rest | ~5 | 0.10 ms | Done (`cc9d911`); spikes only with the page open |
| 8 | 7: companion tick | 4.9 | 0.10 ms | Lua; walking still unmeasured |
| 9 | 16: `relationshipState.update` | 4.8 | 0.10 ms | Lua: per-frame check, 2 s rename |
| 10 | 17: auto-connect + phone style | 4.7 + 4.4 | 0.19 ms | Lua: per-frame refresh gating |
| - | 1b: per-turn request | one 26-81 ms hitch per turn | | Lua and bridge (in progress) |
| - | 18: GC, at least 1.7 MB/s allocated | spread over all sections | | Fewer per-frame tables (collectors, phone, face) |
| - | 3: continuous speech, 10: hooks | not in this capture | | Re-measure |

Item details (costs before the 2026-10-12 capture are the 2026-10-11 numbers):

| # | Hot path (file:line) | Rate | Cost | Fix and route |
| --- | --- | --- | --- | --- |
| 1 | World-knowledge and journal collectors: `updateKnowledge` (`init.lua:157`) steps `world-knowledge.lua:365` and `journal-history.lua:267` from `onUpdate` | Every frame. A cycle reads ~994 facts and journal entries at up to 32 per frame or 2 ms (measured on a 1 ms clock, so 1-3 ms). A new cycle starts about every second, so ~1,000 native reads/s on ~70 % of frames. Journal pages run every 2 s (active lane) and every 30 s (history). About 21 readiness calls per frame on top. | **Measured 2026-10-12: 69 ms/s in game** (worldKnowledge 58.1, journalHistory 11.3), 1.43 ms per frame, and the same before a save load. The largest item. | **Event-driven plus redscript** (section 4). Rescan only when the journal or facts change: redscript journal-state callbacks and a dirty flag. Refresh at once when the composer, phone chat or talk key opens. Idle cadence 30-60 s. Lua's `capture()` rejects a cache older than 5 s (`world-knowledge.lua:457`), so the age rule must change with it; the bridge allows 10 s for journal history. **C++ only if** an event-driven Lua or redscript collector still measures over ~5 ms/s. **Done 2026-10-12 (`843a527`):** a collector with a fresh cache makes no native call. World facts rescan every 30 s (cache valid 45 s, the bridge's `WORLD_SNAPSHOT_MAX_AGE_MS`), the active journal lane every 10 s (valid 15 s), the history lane every 300 s (valid 600 s, the bridge's limit raised to match). A journal change (`JournalNotificationQueue.OnJournalUpdate`, 1 s debounce), the composer opening, the talk key and a phone chat opening with a contact (`01c34de`) start a scan at once. Redscript callbacks were not needed. |
| 1b | Per-turn request: `sendRequest` (`init.lua:1466`) JSON-encodes `journalHistory` (643 KB) and `worldKnowledge` (151 KB) into a 796 KB `last-input.json` on the main thread | Each turn V sends | A 26-72 ms hitch per turn (`json.encode` max in both captures) plus about 9 ms of file operations | **Lua and bridge.** Publish the knowledge snapshot to its own file only when it changes; the turn carries only its revision. Better: the bridge keeps the snapshot and gets deltas. **Done (`4b9ff83`, phone `5c4d870`):** the world facts and the two journal lanes are written to `runtime/knowledge-world|active|history.json` once per revision (`mod/knowledge-parts.lua`); a request carries `ref = {part, revision}` and the lane revisions with row ids. The bridge (`bridge/knowledge-parts.mjs`) rebuilds the exact snapshots before any parser runs and keeps the last 3 revisions per part. A rescan that saw nothing new keeps its revision, so most turns write no part. A part that cannot be read makes that snapshot unavailable for the turn, never a guess. |
| 2 | Lease and heartbeat files (inventory in section 7) | 2-3 s heartbeats, polls at 0.5-1 s | **~46 ms/s measured on 2026-10-11, 32 ms/s on 2026-10-12** after `a9fc6a5` (`io.open` + `os.rename` + `os.remove`; per-file rates in section 1), mostly as 3-12 ms spikes. The 2 s heartbeats all key on whole `os.time()` seconds, so several land in one frame: probably the recurring 50 ms frame. | **Done in part:** world-session, party and invitation leases are written in place (`a9fc6a5`, about 9 ms/s less). **Lua next:** stagger the phases, read memory-chat resets every 5-10 s instead of 0.5 s, write `phone-chat-input` in place every 8 s, read `local-voice-state` and `bridge-service` every 5-10 s, poll the diagnostic mailbox only when `diagnostics.lua` is installed. **C++:** an async IO thread removes all of it (section 3). **Done 2026-10-12:** memory-chat resets every 5 s with no chat open and no reply pending, 0.5 s otherwise (`cb96750`); the diagnostic, face-test and gesture-probe mailboxes every 4 s with Developer mode off, 1 s on (`471de62`; all three ship in the player package, and the request scripts allow 8-10 s); the 2 s heartbeats take one write per frame (`01d93c2`). Left as they are: `companion-actions.json` (read only while a lease is open, and slowing it delays the action) and `local-voice-state.json` (already every 2 s). |
| 3 | Continuous speech while a companion speaks: `continuous-speech.lua:217` | 25 Hz | One `io.open` (~3 ms) plus `json.decode` of up to 12k characters every 40 ms, plus the control-file write. **Estimated 75-100 ms/s while speaking**, a 3 ms hitch on about every second frame. | **C++ async read** (section 3) is the real fix. Lua stopgap: skip the decode when the bridge's revision is unchanged. Do not lower the poll rate without the 80 ms lag allowance at `speech.lua:416`. |
| 4 | Idle face writer: `face.updateExpressions` (`facial-playback.lua:783`), `applyFeature` (`:695`) | Every frame, per companion | **21.9 ms/s measured with one companion (10.2 on 2026-10-12)**, linear in party size. Per actor per frame: about 10 calls for ownership, 17 for `safeExpressionActor` (`:328`) including 5 `CName.new` and 5 status-effect checks, about 60 property reads and writes on the native feature, and a new `appliedPose` table. | **Done (`cf1cdda`): a settled idle face sleeps** between blinks (no native reads or writes), wakes for a blink, a feeling, speech or a phase change, and re-checks every 0.25 s. Needs the in-game check in section 6. Still open: hoist the `CName`s, skip `owns()` for the speaking actor, build `appliedPose` only on demand. Larger: let a settled idle face sleep (no write while the pose is converged and no blink is due), wake at the next blink or within 0.25 s, re-check scene, combat and status every 0.25 s instead of every frame. Needs an in-game check that the native feature holds its last frame. Later, the whole idle layer could move into redscript. |
| 5 | `mcm.update` per-frame `active()` (`mcm.lua:68`) called MCM's `getDiagnostics`, a deep copy of every provider, up to 100 errors and 100 history entries | Every frame | 12.9 ms/s measured | **Done (`cc9d911`):** re-read at most every 0.25 s while our page is not shown. |
| 6 | `phoneChat.update` (`phone-chat.lua:404`) | Every frame, plus a 10 Hz tick | 13.6 ms/s measured: the reset journal read (~5.4), the `phone-chat-input` heartbeat as an atomic write (~5.5), and a per-frame `json.encode` + `json.decode` round trip of the binding (`:405`, ~2.5; it makes the 44/s decode and most of the 48/s encode) | **Lua:** cache the binding by world generation (it depends on nothing else), plus the item 2 file fixes. **Done (`cb96750`):** the binding table is read directly (`binding()` copies five scalar fields; the round trip bought nothing), and the reset journal waits 5 s with no chat open. |
| 7 | `companions.update` (`companions.lua`, 10 Hz) | 10 Hz | 7.6 ms/s idle, 30-40 native calls and ~150 tables per tick. While walking: 30-60 collision `Overlap` calls/s per companion; one tick may spend the 192-query frame budget (`companion-clearance.lua:10`) in a single frame. | **Lua:** run the full tick at 2 Hz while every copy is settled and V stands still (one V position read per tick as the wake-up), cache the six collision `CName`s, lower the per-frame query limit. **C++ later**, if walking measures high: a batched box-check native, one call per route instead of 6 per box. |
| 8 | `invitations.update` (`invitation-readiness.lua`) | Every frame | 6.5 ms/s measured on 2026-10-11, almost all one atomic write every 2 s; 5.9 ms/s on 2026-10-12 after the fix, so per-frame work remains | **Done in part (`a9fc6a5`):** written in place. **Lua next:** the per-frame `synchronize` and world table. |
| 9 | Per-frame `conversationCandidates(player, 1000)` (`init.lua` expression context) | Every frame | 4.5 ms/s measured | **Done (`a3e7bc6`):** `companions.expressionActors`, rebuilt at most every 0.1 s or on a party change. |
| 10 | CET hooks on hot natives (unmeasured until `2821b31`) | See right | Unknown; each call pays the CET trampoline even when the handler returns early | `AIMoveToCommandHandler.UpdateCommand` (`companion-locomotion.lua`) fired per AI tick for every NPC on a MoveTo; it ran the full path whenever a companion existed. **Filtered since 2026-10-17 (branch `movement-hook-filter`):** `Locomotion.reds` reports only the controller's marked commands to Lua; the unit-level measure is in `TODO.md`; the in-game row is still owed. `ReactionManagerComponent.OnEventReceived` and four sibling Overrides (`vanilla-reactions.lua:243`) fire for every stimulus to every NPC, for the rest of the session after the first conversation. `ChatterLineLogicController.UpdateProjection` and `IsBubble` (`subtitles.lua:734`, `:741`) fire per visible chatter line per frame, always registered. The loot hooks run 5+ native calls before checking `enabled`. **Redscript:** `@wrapMethod` filters that test a flag on the NPC, or the mod's ownership, and only then call an empty mod-only method that Lua observes. Lua then sees only our companions. Register the chatter Overrides lazily, as `vanilla-reactions` already does, and check `enabled` first in the loot hooks. |
| 11 | `updateGaze` → `targetAtCrosshair` (`init.lua:1081`, `:896`) | 5 Hz | Estimated 1-5 ms/s, more in crowds. It runs a `GetTargetParts` scan within 8 m plus head-slot transforms even with no companion and auto-connect off. | **Lua:** skip when neither a companion nor auto-connect needs it; use cached positions for owned copies. |
| 12 | Turn-time polls: `reply.json` at 10 Hz while a reply is pending (`init.lua:2556`, up to 90 s); `microphone-state.json` at 10 Hz while recording | 10 Hz during waits | About 30 ms/s while waiting | **Lua** 3-4 Hz (adds 0.1-0.25 s of reply latency), or the C++ reader. |
| 13 | `log()` opens and closes `probe.log` for every line (`init.lua:625`) | Per log line | About 3 ms per line | **Lua:** buffer lines and append at most once a second, with a flush on shutdown. |
| 14 | `gesture-catalog.lua` (35k lines) is loaded by separate `dofile`s in `companion-gestures.lua:47` and `companion-seating.lua:492`, plus the development probe | Load time | Two or three heap copies, so GC pressure | **Lua:** load once and share it. **Done 2026-10-19 (`20aa14fc`):** the gesture controller's copy is handed to seating and preferred by the holocall picture. Measured offline, one copy holds only about 1.1 MB of table data (6,811 tables), so the gain is load time and a few MB, not the large heap of section 10. |
| 15 | init.lua's own work in `onUpdate` (the inline blocks between the wrapped calls) | Every frame and 10 Hz | **~34 ms/s**: `event:onUpdate` 179 minus its wrapped top-level sections (~145). Holds the nearby lease write and rename, the diagnostic mailbox poll, the focus, gaze and talk-target work | **Attribute first:** have the probe time the inline blocks (`perf-probe.watch` cannot reach them; split them into module functions or add labelled timers in Developer mode only). Then Lua fixes. **Done in part:** `convaiPerfMark` segments (`9057812`) give `init:session`, `init:knowledge`, `init:worldReady`, `init:ui`, `init:mcm`, `init:invitations`, `init:partyConnections`, `init:phone`, `init:expressionContext`, `init:speech`, `init:poll` per frame and `init:tick`, `init:group`, `init:battles`, `init:gaze`, `init:reply` at 10 Hz. A segment includes the wrapped sections it calls. The world check no longer repeats `IsAttached`, `IsPreGame` and `GetSystemRequestsHandler` (`4dcc8e4`, four native calls per frame). |
| 16 | `relationshipState.update` (`relationship-state.lua`) | Every frame | 4.8 ms/s | **Lua:** gate the per-frame check; the 2 s write keeps its rename (the bridge acts on an empty read). |
| 17 | `autoConnect.update`/`heartbeat` and `phoneChatStyle.refresh` | Every frame (heartbeat, style), 10 Hz (update) | 4.7 + 4.4 ms/s; the style refresh peaked at 63 ms in one frame | **Lua:** refresh the style only when the phone is shown or its inputs change. |
| 18 | Lua allocation and GC | Continuous | The heap swings between 22 and 46 MB with a drop in half the windows: at least 1.7 MB/s allocated. GC steps land in whichever section allocates | **Lua:** fewer per-frame tables (collector jobs and copies, the phone binding round trip, the face writer's tables, now reused). |

## 3. Native route

### Decision

Each class of hot path gets a different route:

- **C++ RED4ext plugin for file IPC.** This is the one measured cost Lua cannot fix. CET Lua has no
  asynchronous file IO, so every lease, mailbox and stream read runs on the game thread at 1-5 ms per
  operation. That is ~46 ms/s idle (item 2; 32 ms/s on 2026-10-12 after the in-place leases) and an estimated 75-100 ms/s while speaking (item 3). A native
  worker thread does the IO off the game thread, and the main thread pays a few microseconds per call.
- **Redscript for hook filtering and change events** (items 1 and 10). Compiled redscript in a `@wrapMethod`
  is far cheaper than a CET trampoline on a native that fires for every NPC. The journal system already
  raises state-change callbacks, so the collector can wait for one instead of polling.
- **Lua fixes for everything else** (items 4-9, 11-14): caching, lower rates, gating and dirty flags. Most
  per-frame cost is many small native calls and table churn, and moving it into C++ would still cross the
  same boundary.
- **Not C++ yet:** the knowledge collector (measured 69 ms/s; try event-driven Lua first, see section 4), the idle face layer (try sleeping first),
  and spatial queries (measure walking first). Each can follow if the probe still shows it high after the
  Lua or redscript fix.

### Plugin architecture

- **Separate plugin.** `CyberpunkConvaiNative.dll` in its own folder, `red4ext/plugins/AiNpcCyberpunkModNative/`.
  It is separate from the launcher plugin so that a patch-day refusal never stops the bridge from starting.
- **RTTI registration only.** It registers one native class, `ConvaiNative` (static functions on an
  `IScriptable`), through `CRTTISystem` register and post-register callbacks. No hooks, no offsets, no game
  memory reads. The C++ example in `vendor/reference-ai-npc/plugin/ScriptApi.cpp` uses this exact pattern.
- **No `.reds` declaration.** CET reads the RTTI directly, so Lua calls `ConvaiNative.Read(...)` without a
  redscript `native` declaration. If a `.reds` file declared a native type that no plugin registered, the
  game would refuse to start. Without the declaration, a missing or refused DLL means only that Lua's probe
  fails: `pcall` plus `type(ConvaiNative)` at load. The current Lua path then keeps running unchanged.
- **API (all strings are UTF-8; channels are a fixed whitelist of `runtime/` file names, never paths):**
  - `Version() -> Int32`
  - `Write(channel, text) -> Bool`: queues. The worker writes `.tmp` then `MoveFileExW(REPLACE_EXISTING)`
    (a true atomic replace on Windows, so the bridge never sees a torn file) and skips bytes that are
    already identical.
  - `Lease(channel, template, periodMs) -> Bool`: the worker rewrites the file every `periodMs` with the
    `updated` field set to the current time. Lua calls it only when the content changes. This replaces the
    2 s heartbeats of world-session, relationship-state, party, invitations, nearby, speech-state and
    phone-chat-input.
  - `Read(channel) -> String`: the latest content if it changed since the last `Read` on that channel,
    otherwise an empty string. The worker watches with `ReadDirectoryChangesW`, or polls at its own rate
    off the main thread.
  - `Revision(channel) -> Uint64`: a cheap "has it changed" check.
- **Threading.**
  - One worker thread, started in the plugin's `Load`, flushed and joined in `Unload`.
  - The main thread only takes a mutex and copies a string, so each call costs microseconds plus CET's
    string marshalling (estimated 5-20 µs).
- **Paths.** The runtime folder comes from the DLL's own location: game root, then
  `bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod/runtime`.
- **Build.**
  - C++20 with MSVC 2022 and CMake. Locally, VS 2022 17.14 (MSVC 14.44) and CMake 3.27 are installed. The
    release runner `windows-2025` has VS 2022.
  - RED4ext.SDK is pinned as a git submodule or CMake FetchContent at a fixed commit. It is not on disk today:
    `vendor/reference-ai-npc/vendor/RED4ext.SDK` is an empty submodule.
  - Static CRT (`/MT`) and `/Brepro`, as `scripts/Build-AutostartPlugin.ps1` already does.
  - A new `scripts/Build-NativePlugin.ps1` is called from `packaging/build-release.mjs`.
  - The DLL ships in the Runtime package. The Scripts package guard allows only `.lua`, `.reds`, `.json` and
    `.txt`.
- **Dependencies.** No new Nexus requirement: RED4ext is already required, and Codeware, also required, is
  itself a RED4ext RTTI plugin.
- **Installed versions** (game 2.31, file version 3.0.80.51928): RED4ext 1.30.0, CET 1.37.1, Codeware 1.20.5,
  TweakXL 1.11.4, Audioware 1.9.9-rc.0.

### Patch safety

An RTTI-only plugin is the most patch-tolerant kind that still registers types, but it is not
version-independent. The reference plugin's notes call declaring `RUNTIME_VERSION_INDEPENDENT` while
registering RTTI off-label.

Plan:
- Declare the supported game version.
- On a game patch, RED4ext refuses the plugin until it is rebuilt against the updated SDK.
- Lua falls back to file IO on its own. The mod keeps working, only slower, and the support report shows
  which path is in use.
- The release workflow can rebuild the DLL with no code change when only the SDK version moves.

## 4. Order of work

Revised 2026-10-12 from the first whole-callback measurement (section 1).

**Collector redesign before C++ file IO.** The collectors cost 69 ms/s (1.43 ms per frame), file IO 32 ms/s
(0.66 ms). The collector fix is pure Lua and needs no build, DLL or patch-day fallback. Each collector read
costs about 58 µs through CET (58 ms/s over roughly 1,000 reads/s), so the cost is the read count: reading
only when the journal changes, or before a turn, removes most of it. A C++ collector would make each read
nearly free, but it needs much more game API surface than the file layer, and it waits on the plugin. The
two do not conflict: the C++ file layer on `native-core` can proceed in parallel, and its first targets stay
the leases, mailboxes and the continuous-speech read.

1. **Knowledge collector redesign** (item 1), in Lua, together with 1b (the revision-based payload; it
   touches the same capture path). **Done: `843a527`, `4b9ff83`, `5c4d870`, `01c34de`.**
   - stop stepping once a fresh cycle is cached; rescan on a long idle cadence (30-60 s) and at once when
     the composer, phone chat or talk key opens;
   - lower the per-frame budget from 2 ms to a few reads per frame;
   - later, redscript journal callbacks as a dirty flag;
   - change the 5 s cache age rule and the bridge's 10 s journal rule with it, so the first send still has
     fresh context.
   Expected: most of 69 ms/s, about 3 FPS at 48 fps.
2. **Lua file-IO cadence cuts** (item 2), about 10 ms/s. **Done: `cb96750`, `471de62`, `01d93c2`.** memory-chat resets every 5-10 s instead of 0.5 s
   (a fresh read before submission already exists), `companion-actions.json` and `local-voice-state.json`
   less often, the diagnostic mailbox only when `diagnostics.lua` is installed.
3. **Attribute init.lua's own 34 ms/s** (item 15) with Developer-mode timers, then fix what it shows.
   **Timers done (`9057812`), one fix (`4dcc8e4`); the rest waits for the next capture.**
4. **Smaller per-frame Lua wins:** phone chat (item 6), invitations (item 8), relationship (item 16), phone
   style and auto-connect (item 17), lazy chatter Overrides and `enabled`-first loot hooks (item 10), the
   gaze skip (item 11), buffered `log()` (item 13), one shared gesture catalog (item 14).
5. **The native IPC plugin** (`native-core`), behind automatic detection with the Lua fallback. Compare the
   probe with the DLL present and removed. The continuous-speech read first, then the leases, then the
   mailboxes and reply polls.
6. **Redscript hook filters** for `UpdateCommand` and `ReactionManagerComponent`, once the hook rows
   (`49f89b8`) show their cost. A compile error disables the whole mod's redscript, so each filter is small
   and built in isolation first.
7. **Companion tick settle gating and a batched spatial native** (item 7), only if walking measures high.

## 5. Risks

- **Bridge leases.**
  - Writing a lease less often, or in place, can make the bridge drop warm connections or voices if it reads
    a stale or torn file.
  - Limits: world-session, relationship-state and speech-state have 5 s leases (keep 2 s writes); party and
    invitations 6.5 s; nearby 8 s; phone-chat-input 15 s.
  - The relationship and nearby readers act on an empty read, so they keep the rename until the native
    writer replaces it.
- **Knowledge freshness.**
  - An event-driven collector must refresh before the first send, or replies lose world context.
  - The 5 s cache age rule in `world-knowledge.lua` and the bridge's 10 s journal rule must change with it.
    Changed in `843a527`: world facts 45 s, active journal 15 s, history 600 s, the same limits on both
    sides. A fact that changes without a journal update can be up to 30 s old at a turn the talk key or
    composer did not start (a phone reply already rescans when the chat opens).
- **Face behaviour.**
  - Sleeping or rate-limiting the idle writer can show a stepped blink.
  - It can also leave a smile on for up to 0.25 s into a scene or combat.
  - It can delay the first speech frame.
- **Native plugin.**
  - It is tied to a game version. A patch refuses it until it is rebuilt (the Lua fallback covers this).
  - It adds a build dependency (SDK pin, CI step) and DLL packaging.
  - Antivirus false positives on a new unsigned DLL.
- **Redscript.** One compile error disables every `.reds` file of the mod, including the face and phone
  features.
- **Measurement.**
  - `os.clock` has 1 ms resolution in CET. Means over many calls are fine; single maxima are coarse.
  - The development install runs probes that players do not (section 1.2).
  - The 2026-10-11 capture had one idle companion: walking, crowds and speech are unmeasured.

## 6. What the user should run

After the coordinator installs the committed `mod/` files (CET reload):

1. Turn on Developer mode in Settings and stay in gameplay with one companion summoned.
2. Stand still for 2 minutes in a quiet place, then 2 minutes in a crowded street.
3. Walk 2 minutes with the companion following.
4. Have one spoken conversation of three or four replies.
5. Send `<mod>/runtime/perf-probe.json`. It keeps the last 5 minutes, so copy it right after step 4, or after
   each step for clean windows.

The 2026-10-12 copy held a fresh session (load, one typed reply), not these steps; repeat them, and copy
the file within 5 minutes of the step to keep. The face check for `cf1cdda`: at idle, blinks and the resting
smile look as before, and the face never snaps to neutral between blinks (that would mean the native feature
does not keep its last frame; set `convaiFacialPlayback.idleSleep=false` in the CET console to compare).

The new rows to read are:
- `event:onUpdate`, the whole callback;
- `init:*`, init.lua's own segments (`9057812`; each includes the wrapped sections it calls);
- `over25ms` and `frameMaxMs`, which should drop now that the 2 s heartbeats write one per frame (`01d93c2`);
- `hook:*`, the per-hook calls and ms/s, and `hooksWrapped` (above 0 once the wrap took);
- `worldKnowledge.update`, `journalHistory.update` and `relationshipState.update` (the collectors should be near
  zero between scans after `843a527`);
- `json.encode` max during a turn, and `runtime/knowledge-world.json`, `knowledge-active.json` and
  `knowledge-history.json` next to `last-input.json` (written once per revision; `last-input.json` itself
  should now be a few KB). Replies must still know the current quest and nearby facts;
- `luaKB`.

## 7. Lease and mailbox inventory

`mod/*.lua`, excluding `diagnostics.lua` and the probes. "Atomic" means `.tmp`, `os.remove`, `os.rename`.

| File | Writer or reader | Period | Write style | Bridge lease |
| --- | --- | --- | --- | --- |
| `world-session.json` | `publishWorldSession` (`init.lua:100`) | 2 s + changes | In place (`a9fc6a5`) | 5 s |
| `party-connections.json` | `publishPartyConnections` (`init.lua:607`) | 2 s + changes | In place (`a9fc6a5`) | 6.5 s |
| `companion-invitations.json` | `invitation-readiness.lua` `writeFile` | 2 s + changes | In place (`a9fc6a5`) | 6.5 s |
| `relationship-state.json` | `relationship-state.lua:31` | 2 s | Atomic | 5 s |
| `nearby-connections.json` | `auto-connect.lua:65` | 2 s while a list exists | Atomic | 8 s |
| `speech-state.json` | `speech.lua` `publish` | 2 s + events | In place | 5 s |
| `phone-chat-input.json` | `phone-chat.lua:107`, heartbeat `:559` | 3 s | Atomic | 15 s |
| `memory-chat-resets.json` (read) | `phone-chat.lua:433` | 0.5 s | - | - |
| `local-voice-state.json` (read) | `manager.lua` | 2 s | - | - |
| `bridge-service.json` (read) | `service-status.lua` notice | 3 s | - | - |
| `diagnostic-request.txt` (read) | `init.lua:2418` | 1 s, also for players, though `diagnostics.lua` is not shipped | - | - |
| `continuous-speech.json` (read) | `continuous-speech.lua:217` | 25 Hz while speaking | - | - |
| `continuous-control.json` | `continuous-speech.lua:52` | 150 ms or on change while speaking | In place | - |
| `reply.json` (read) | `init.lua:2556` | 10 Hz while a reply is pending | - | - |
| `last-input.json` | `sendRequest` (`init.lua:1466`) | Per turn, 796 KB | Atomic | - |
| `probe.log` | `log` (`init.lua:625`) | Per line | Append | - |

## 8. The 2026-10-13 capture and the second Lua round

Capture: `perf-*.json` in `E:\CyberpunkConvai-offload\work\perf-2026-10-13\`, 2 s windows, one companion, with
`face-test.lua` installed (the dev install). Stutters first (maxMs over 25), then steady cost. Numbers are
expected savings from the capture; the next live capture is the proof.

| Item | Before | After (expected) | Change |
| --- | --- | --- | --- |
| 3: continuous speech, face file decode while speaking | `speech.update` 85-115 ms/s, `json.decode>=32KB` hitches | about 4-8 ms/s | `continuous-face.json` is written in line segments (`bridge/continuous-face-file.mjs`); `continuous-speech.lua` keeps per-line text and parsed rows and reads row lists with `gmatch`/`tonumber`. Negotiated by `speech-state.continuousFaceSegments`; an old game still gets the plain document, and a file not in segment layout falls back to a whole decode |
| 4: face row validation | about 3 ms/s | about 0 | A weak-table cache of verified rows in `facial-playback.lua` (`M.checkedRows`) |
| 4: idle face writer | `face.updateExpressions` about 18 ms/s | about 2-3 ms/s (1-2 if the native route registers) | The sleep gate and the native route refused whenever `face-test.lua` was loaded; now only while a probe run is active (`probeBusy()`). Per-frame allocations removed, an idle copy writes only changed controls |
| Probe self-cost | about 20 ms/s | about 2 ms/s | `perf-probe.lua` keeps pre-encoded row strings and writes the history every 10 s (flushed on Developer off and uninstall) |
| 5: MCM | closed 8.5, open 183 ms/s | closed about 1.3, open about 60 | Diagnostics 1 s hidden / 0.25 s shown, 0.25 s tick for the queue, notices and identity, local voice state decoded once per file text, bounded style batches |
| 1: knowledge | `init:knowledge` 15.9 ms/s, first-frame hitch 294 ms | about 6.8 ms/s, hitch about 10 ms | Cache-age rules (world 45 s, active journal 15 s, history 600 s) and demand-driven collectors |
| 15: init steady state | about 5-7 ms/s over the phone, party look, auto-connect and manager blocks | about 0 | Fingerprints and ticks instead of per-frame work |

Ship together: the new `mod/journal-history.lua` needs the new `bridge/journal-history.mjs` (`freshQuest`); an
older bridge drops the history after 600 s. `bridge/continuous-face-file.mjs` is a new bridge module (listed in
`packaging/release-plan.json` and `packaging/runtime-layout.mjs`).

Done 2026-10-13 (not yet measured live): `init:expressionContext` (about 1.1 ms/s) built a context table and an actors table
every frame and called `IsInCombat()` in a pcall closure each frame. `convaiExpressionFrame` in `init.lua` now refills one
context table, takes the actor rows from `companions.expressionActors` (rebuilt at most every 0.1 s) and samples `IsInCombat()`
at that same cadence (at once when the rows were rebuilt, forgotten on a loading screen), so a face still reacts to combat
within 0.1 s. At 60 fps that is about 10 native combat reads a second instead of 60, and no per-frame allocation. The
`expressionActors` rebuild itself (about 0.1 ms, 10 a second) stays. Expected: roughly 0.5-0.9 of the 1.1 ms/s; confirm
with the next probe capture.

Open, not done: a blocked
face (combat or scene) cannot sleep because the native settled test also requires "not blocked" (needs a change
under `native/`); the mailbox poll in `face-test.lua` is all of `face.beginExpressionFrame` in the dev install.

## 9. The third Lua round, 2026-10-14 (`lua-perf-2`; committed and unit-tested, not installed or live)

What is left in `invitations`, `relationship`, `phone style` and `auto-connect` is mostly the 2 s lease writes (an in-place
write is one `io.open`, about 3 ms; the relationship and nearby files keep their atomic write until the native writer
replaces it, section 5). The per-frame code around them was already a few table reads. This round removes what it still
built or matched every frame, and the other items of section 4 step 4 that were not done:

| Item | Where | Change | Expected |
| --- | --- | --- | --- |
| 8 invitations, world answer | `invitation-readiness.lua` `currentWorld`, `init.lua` `invitations` `world` | The validated world answer is kept; the same token and generation is the same answer (no 160-character pattern match and no two tables per frame). `init.lua` hands over the held frame instead of a fresh table | about 0.1 ms/s |
| 8 invitations, notice board | `manager-party.lua` `B.take` (called every frame by `updatePhoneInvitationFeedback`) | Idle early-out: nothing followed, joined or failed returns at once. It used to build an in-flight table, a lines table and three burst tables, and read the clock twice, every frame | about 0.15-0.3 ms/s, about 300 tables/s less garbage |
| 16 relationship | `relationship-state.lua` | No change. The per-frame check is a few comparisons; the 4.8 ms/s is the atomic 2 s write (open, remove, rename), which stays (the bridge acts on an empty read) | 0 |
| 17 phone style | `phone-chat-style.lua` `refresh` | A closed phone clears the message-font scope only when it holds records (`clear()` built a new table every frame). The `manager.update` wrapper that also called `refresh` is never installed in production (`install()` has no `live`) | about 0.02 ms/s |
| 17 auto-connect | `auto-connect.lua` `look`, `update` | An empty look table is kept instead of rebuilt (5 + 10 times a second). The heartbeat was already throttled to 4 Hz | negligible |
| 10 chatter Overrides | `subtitles.lua` `install`, `prepare` | `ChatterLineLogicController.IsBubble` and `.UpdateProjection` (per visible chatter line, every frame, for every NPC) register when the first overhead caption is prepared, not at load, as `vanilla-reactions` does. A session with no overhead caption never pays the CET trampoline. `status().projectionGuards`/`projectionGuardError` report it | per hooked call, see the `hook:ChatterLineLogicController.*` rows of the next capture |
| 10 loot hooks | `loot-observer.lua` `configure({enabled})`, `onIntent`, `onTransfer`, `onPurchase` | With Loot reactions off an interaction, a transfer or a purchase makes no native call and captures no context (it used to read the player, the battle sample, the blackboard and every witness, then find `enabled` false). The ownership observers (`OnItemAdded`, `Changed`, `BeingRemoved`) are unchanged: they keep the ever-owned set current | one 1-3 ms hitch per loot interaction while off |
| 13 `log()` | `init.lua` `log`, `convaiLogTick`, `convaiLogFlush` | Lines wait in a buffer and are appended together: one second after the first, at 64 lines or 8 KB, at once for a line naming a failure, error, abandon, shutdown or crash (with everything before it), before `abandonSession`, and in `onShutdown`. The console print stays immediate. An empty buffer costs one field read per frame | about 3 ms per line saved (about 1 ms/s steady, 20-60 ms per conversation turn) |

Notes:
- Modules that append to `probe.log` themselves (the `companion-*-native.lua` diagnostics, `companion-records.lua`) do not
  go through the buffer, so their rare lines can land up to a second ahead of buffered lines logged just before them. Every
  line carries its own UTC stamp.
- Not done: the gaze skip (item 11) saves nothing while a companion is out, the shared gesture catalog (item 14) and the lease
  and heartbeat writes stay for the native layer. A persistent open handle for the in-place leases would save about 6 ms/s but
  may keep the bridge from deleting the files on Windows; it needs the bridge checked first.
- Tests: `bridge/lua-idle-work.test.mjs` (log buffer, idle board, world answer, phone style, auto-connect), plus the
  subtitles and loot-observer tests. Live check: the first reply after a load still shows its overhead caption in the right
  place (the Overrides now register then), and `probe.log` still ends with the shutdown line after a CET reload.

## 10. The fifth round, 2026-10-19 (`perf-study`; unit-tested, the native part built and tested locally, not installed or live)

The 2026-10-19 capture (150 windows, 2026-10-18 21:57 to 22:02 UTC, one idle companion, 58.9 fps) put `event:onUpdate` at 38 ms/s (0.65 ms a frame, 3.8 % of the
frame; 179 ms/s on 2026-10-12). The probe file is replaced at every session start, so copy it after each run. Findings: a native call through CET costs 25 to 30 µs
here (`init:session`, five calls, is 8.25 ms/s); the stutters (27 frames over 40 ms in 300 s) are not in the mod's Lua (worst `onUpdate` in those windows 3 to 13 ms against frames of 41 to 109 ms);
no `hook:` row appeared because no hook fired (idle companion, no crowd); the Lua heap was 145 to 243 MB in game against 33 to 43 MB at the menu and is not explained (attribute it with
`collectgarbage(); print(collectgarbage('count'))` before and after clearing one structure at a time).

| Change | Commit | Expected |
| --- | --- | --- |
| speech reads V only on the heartbeat frame or while a reply plays | `444d1a43` | one native call a frame at rest, about 1.5 ms/s |
| subtitles hooks return before any native read while no caption of ours is up | `ddbf2a05` | a closure and two native calls per crowd chatter line event |
| vanilla-reaction hooks idle again once every hold has run out | `78daabef` | no stimulus read or owner lookup per NPC event after a finished conversation |
| onUpdate's session, pause, phone, composer and submission checks are named functions; the tick reuses the frame's V | `08f7f58f` | about 5 closures a frame and one native call at 10 Hz |
| cloud voice uses the text routes' keep-alive pool and reads a finished stream to its end | `500c729d` | 40 to 97 ms (a new TLS connection to the provider, measured) off the first audio of each request that paid one |
| native worker checks JSON before taking the mutex | `4998a36b` | game-thread `Revision()` stalls: about 70 calls over 1 ms and 7 to 8 ms worst, to 0 to 2 and 0.4 to 2.4 ms (twenty 2 MB documents) |
| native directory watcher wakes the worker on a replaced file | `2a82b154` | bridge-to-game hop p50 15.2 to 0.6-1.2 ms, p95 30 to 10-13 ms (40 replaced files) |
| speaking frames: V from init.lua, the cached menu flag, no closures in the setting reads | `d62d61ea` | about six native calls and three closures fewer a frame while a reply plays, about 9 ms/s |

Left, with the reasons: the five-call session check every frame (about 3 ms/s if throttled, but a stale player handle after a load is what it guards against; needs a change event and a load test),
the phone-open read (1.5 ms/s; a hook on the phone), the relationship facts read every 2 s (25 native calls in one frame), the 10 Hz tick (about 5 ms/s). Live plan: Developer-mode runs A to G
(idle, crowd, walking, speaking, after a conversation, native status, voice latency) against the numbers above; the speaking windows (`speaking: true`) show the `speech.update` and `subtitles.update` gain,
`hook:ReactionManagerComponent.*` should be near zero after a conversation, `ConvaiNative.Status()` shows `watchEvents`, and `bridge-latency.json` shows the voice's first PCM for the second request of a reply.
