# Performance plan: hot Lua paths and the native route

Written 2026-10-12. FPS is the top priority: even a 2-3 FPS loss is unacceptable, and the mod adds no per-frame
main-thread work it can avoid. This document ranks where the CET Lua spends the game thread's time, says which
route each hot path should take (a Lua fix, redscript, or a C++ RED4ext native), and gives the order of work.
C++ is not the goal in itself; fewer milliseconds per frame is.

Units: **ms/s** is milliseconds of game-thread time per second of play. At 44 fps (22.8 ms frames), 44 ms/s
is 1 ms per frame. When the game is limited by its main thread, removing 1 ms per frame at 44 fps is worth
about 2 FPS (44 to 46); at 60 fps it is worth about 4 FPS.

## 1. Evidence

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

### 1.1 The probe could not see hooks (fixed)

`init.lua` loads `perf-probe.lua` twice: `hookRegistrations` at the top, `install` after the modules. The
second chunk got its own `enabled` flag, so every `hook:Class.Method` and `event:onUpdate` wrapper made by the
first chunk never recorded. That is why the 2026-10-11 capture has none of those rows.

Commit `2821b31` fixes this: a second load returns the first chunk. It also times the following, so
`event:onUpdate` minus the sections leaves only init.lua's own local work:
- the rest of the per-frame top half: `ui.update`, the composer, phone layout and style, auto-connect;
- the 10 Hz `manager`, `tactics`, `microphone` and `movementLog` updates;
- `worldKnowledge.update`, `journalHistory.update` and `relationshipState.update`.

It also records the Lua heap (`luaKB`) per window. 65 of the 150 windows hold a frame over 60 ms with no mod
section near that, which looks like a shared stall: a GC step, the file system or antivirus, or a game hitch.

### 1.2 What this install measures that players do not run

The user's development install also runs `face-test.lua` and `gesture-probe.lua`. Each polls a request file
once a second, about 3 ms each. Developer logging and the movement trace are also on. Releases exclude both
probes (`packaging/release.config.json` `devOnlyLua`), so players pay a little less than the numbers above.
`perf-probe.lua` ships but stays inert unless Developer mode is on.

## 2. Ranked hot paths

Ranked by expected ms/s saved, then by how sure the number is. Done items name their commit.

| # | Hot path (file:line) | Rate | Cost | Fix and route |
| --- | --- | --- | --- | --- |
| 1 | World-knowledge and journal collectors: `updateKnowledge` (`init.lua:157`) steps `world-knowledge.lua:365` and `journal-history.lua:267` from `onUpdate` | Every frame. A cycle reads ~994 facts and journal entries at up to 32 per frame or 2 ms (measured on a 1 ms clock, so 1-3 ms). A new cycle starts about every second, so ~1,000 native reads/s on ~70 % of frames. Journal pages run every 2 s (active lane) and every 30 s (history). About 21 readiness calls per frame on top. | **Unmeasured. Estimated 20-90 ms/s.** Probably the largest item. | **Event-driven plus redscript** (section 4). Rescan only when the journal or facts change: redscript journal-state callbacks and a dirty flag. Refresh at once when the composer, phone chat or talk key opens. Idle cadence 30-60 s. Lua's `capture()` rejects a cache older than 5 s (`world-knowledge.lua:457`), so the age rule must change with it; the bridge allows 10 s for journal history. **C++ only if** an event-driven Lua or redscript collector still measures over ~5 ms/s. |
| 1b | Per-turn request: `sendRequest` (`init.lua:1466`) JSON-encodes `journalHistory` (643 KB) and `worldKnowledge` (151 KB) into a 796 KB `last-input.json` on the main thread | Each turn V sends | A 26-72 ms hitch per turn (`json.encode` max in both captures) plus about 9 ms of file operations | **Lua and bridge.** Publish the knowledge snapshot to its own file only when it changes; the turn carries only its revision. Better: the bridge keeps the snapshot and gets deltas. |
| 2 | Lease and heartbeat files (inventory in section 7) | 2-3 s heartbeats, polls at 0.5-1 s | **~46 ms/s measured** (`io.open` + `os.rename` + `os.remove`), mostly as 3-12 ms spikes. The 2 s heartbeats all key on whole `os.time()` seconds, so several land in one frame: probably the recurring 50 ms frame. | **Done in part:** world-session, party and invitation leases are written in place (`a9fc6a5`, about 9 ms/s less). **Lua next:** stagger the phases, read memory-chat resets every 5-10 s instead of 0.5 s, write `phone-chat-input` in place every 8 s, read `local-voice-state` and `bridge-service` every 5-10 s, poll the diagnostic mailbox only when `diagnostics.lua` is installed. **C++:** an async IO thread removes all of it (section 3). |
| 3 | Continuous speech while a companion speaks: `continuous-speech.lua:217` | 25 Hz | One `io.open` (~3 ms) plus `json.decode` of up to 12k characters every 40 ms, plus the control-file write. **Estimated 75-100 ms/s while speaking**, a 3 ms hitch on about every second frame. | **C++ async read** (section 3) is the real fix. Lua stopgap: skip the decode when the bridge's revision is unchanged. Do not lower the poll rate without the 80 ms lag allowance at `speech.lua:416`. |
| 4 | Idle face writer: `face.updateExpressions` (`facial-playback.lua:783`), `applyFeature` (`:695`) | Every frame, per companion | **21.9 ms/s measured with one companion**, linear in party size. Per actor per frame: about 10 calls for ownership, 17 for `safeExpressionActor` (`:328`) including 5 `CName.new` and 5 status-effect checks, about 60 property reads and writes on the native feature, and a new `appliedPose` table. | **Lua.** Partial, no behaviour change: hoist the `CName`s, skip `owns()` for the speaking actor, build `appliedPose` only on demand. Larger: let a settled idle face sleep (no write while the pose is converged and no blink is due), wake at the next blink or within 0.25 s, re-check scene, combat and status every 0.25 s instead of every frame. Needs an in-game check that the native feature holds its last frame. Later, the whole idle layer could move into redscript. |
| 5 | `mcm.update` per-frame `active()` (`mcm.lua:68`) called MCM's `getDiagnostics`, a deep copy of every provider, up to 100 errors and 100 history entries | Every frame | 12.9 ms/s measured | **Done (`cc9d911`):** re-read at most every 0.25 s while our page is not shown. |
| 6 | `phoneChat.update` (`phone-chat.lua:404`) | Every frame, plus a 10 Hz tick | 13.6 ms/s measured: the reset journal read (~5.4), the `phone-chat-input` heartbeat as an atomic write (~5.5), and a per-frame `json.encode` + `json.decode` round trip of the binding (`:405`, ~2.5; it makes the 44/s decode and most of the 48/s encode) | **Lua:** cache the binding by world generation (it depends on nothing else), plus the item 2 file fixes. |
| 7 | `companions.update` (`companions.lua`, 10 Hz) | 10 Hz | 7.6 ms/s idle, 30-40 native calls and ~150 tables per tick. While walking: 30-60 collision `Overlap` calls/s per companion; one tick may spend the 192-query frame budget (`companion-clearance.lua:10`) in a single frame. | **Lua:** run the full tick at 2 Hz while every copy is settled and V stands still (one V position read per tick as the wake-up), cache the six collision `CName`s, lower the per-frame query limit. **C++ later**, if walking measures high: a batched box-check native, one call per route instead of 6 per box. |
| 8 | `invitations.update` (`invitation-readiness.lua`) | Every frame | 6.5 ms/s measured, almost all one atomic write every 2 s | **Done (`a9fc6a5`):** written in place. |
| 9 | Per-frame `conversationCandidates(player, 1000)` (`init.lua` expression context) | Every frame | 4.5 ms/s measured | **Done (`a3e7bc6`):** `companions.expressionActors`, rebuilt at most every 0.1 s or on a party change. |
| 10 | CET hooks on hot natives (unmeasured until `2821b31`) | See right | Unknown; each call pays the CET trampoline even when the handler returns early | `AIMoveToCommandHandler.UpdateCommand` (`companion-locomotion.lua:38`) fires per AI tick for every NPC on a MoveTo; it runs the full path whenever a companion exists. `ReactionManagerComponent.OnEventReceived` and four sibling Overrides (`vanilla-reactions.lua:243`) fire for every stimulus to every NPC, for the rest of the session after the first conversation. `ChatterLineLogicController.UpdateProjection` and `IsBubble` (`subtitles.lua:734`, `:741`) fire per visible chatter line per frame, always registered. The loot hooks run 5+ native calls before checking `enabled`. **Redscript:** `@wrapMethod` filters that test a flag on the NPC, or the mod's ownership, and only then call an empty mod-only method that Lua observes. Lua then sees only our companions. Register the chatter Overrides lazily, as `vanilla-reactions` already does, and check `enabled` first in the loot hooks. |
| 11 | `updateGaze` → `targetAtCrosshair` (`init.lua:1081`, `:896`) | 5 Hz | Estimated 1-5 ms/s, more in crowds. It runs a `GetTargetParts` scan within 8 m plus head-slot transforms even with no companion and auto-connect off. | **Lua:** skip when neither a companion nor auto-connect needs it; use cached positions for owned copies. |
| 12 | Turn-time polls: `reply.json` at 10 Hz while a reply is pending (`init.lua:2556`, up to 90 s); `microphone-state.json` at 10 Hz while recording | 10 Hz during waits | About 30 ms/s while waiting | **Lua** 3-4 Hz (adds 0.1-0.25 s of reply latency), or the C++ reader. |
| 13 | `log()` opens and closes `probe.log` for every line (`init.lua:625`) | Per log line | About 3 ms per line | **Lua:** buffer lines and append at most once a second, with a flush on shutdown. |
| 14 | `gesture-catalog.lua` (35k lines) is loaded by separate `dofile`s in `companion-gestures.lua:47` and `companion-seating.lua:492`, plus the development probe | Load time | Two or three heap copies, so GC pressure | **Lua:** load once and share it. |

## 3. Native route

### Decision

Each class of hot path gets a different route:

- **C++ RED4ext plugin for file IPC.** This is the one measured cost Lua cannot fix. CET Lua has no
  asynchronous file IO, so every lease, mailbox and stream read runs on the game thread at 1-5 ms per
  operation. That is ~46 ms/s idle (item 2) and an estimated 75-100 ms/s while speaking (item 3). A native
  worker thread does the IO off the game thread, and the main thread pays a few microseconds per call.
- **Redscript for hook filtering and change events** (items 1 and 10). Compiled redscript in a `@wrapMethod`
  is far cheaper than a CET trampoline on a native that fires for every NPC. The journal system already
  raises state-change callbacks, so the collector can wait for one instead of polling.
- **Lua fixes for everything else** (items 4-9, 11-14): caching, lower rates, gating and dirty flags. Most
  per-frame cost is many small native calls and table churn, and moving it into C++ would still cross the
  same boundary.
- **Not C++ yet:** the knowledge collector (try event-driven first), the idle face layer (try sleeping first),
  and spatial queries (measure walking first). Each can follow if the probe still shows it high after the
  Lua or redscript fix.

### Plugin architecture

- **Separate plugin.** `CyberpunkConvaiNative.dll` in its own folder, `red4ext/plugins/CyberpunkConvaiNative/`.
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
  `bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvai/runtime`.
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

1. **Measure with the fixed probe** (section 6). Get real numbers for the collectors (item 1), the hooks
   (item 10), init.lua's own local work, and walking and speaking. Re-rank before building anything large.
2. **Remaining Lua quick wins**, smallest risk first:
   - the phone binding cache (item 6);
   - the reset-journal and voice-state read periods, and `phone-chat-input` in place (item 2);
   - the diagnostic mailbox only when `diagnostics.lua` is present;
   - the face writer's partial fixes (item 4);
   - lazy chatter Overrides and `enabled`-first loot hooks (item 10);
   - the gaze skip (item 11), buffered `log()` (item 13), and one shared gesture catalog (item 14);
   - staggered heartbeat phases (item 2).
3. **Knowledge collector redesign** (items 1 and 1b):
   - event-driven rescans from redscript journal callbacks;
   - a refresh on composer, phone or talk open;
   - a long idle cadence;
   - a knowledge snapshot file plus a revision in the turn instead of 796 KB per turn.
   This needs the bridge's knowledge side; coordinate it with the dynamic-context work
   (`docs/DYNAMIC_CONTEXT_AUDIT.md`).
4. **Redscript hook filters** for `UpdateCommand` and `ReactionManagerComponent`, if step 1 shows them.
   A compile error disables the whole mod's redscript, so each filter is small and built in isolation first.
5. **The native IPC plugin.** Build it behind automatic detection with the Lua fallback. Compare the probe
   with the DLL present and removed. Move the continuous-speech read first (largest), then the leases, then
   the mailboxes and reply polls.
6. **Face writer sleep gate** (item 4), with an in-game check of blinks, the resting smile, expressions after
   speech, combat and scene blocking.
7. **Companion tick settle gating, and a batched spatial native** (item 7), only if walking measurements
   justify them.

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

The new rows to read are:
- `event:onUpdate`, the whole callback;
- `hook:*`, the per-hook calls and ms/s;
- `worldKnowledge.update`, `journalHistory.update` and `relationshipState.update`;
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
