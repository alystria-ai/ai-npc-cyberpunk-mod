# Native rewrite plan (branch `native-core`)

Goal: move the game-side work that costs frame time out of CET Lua into a RED4ext plugin, one
system at a time, with the Lua path kept as the fallback. Nothing here may put v0.2 (Sun 18 Oct)
at risk: a system ships in 0.2 only if it passed an in-game test by the evening of Fri 16 Oct.

Measured baseline (live capture, 2026-10-12, 48 fps): Lua onUpdate costs 179 ms/s, 3.7 ms a
frame. Knowledge collectors 69 ms/s, file IO 32 ms/s (io.open 24.5, os.rename 6.1), init.lua's own
unwrapped work about 34 ms/s. In CET one io.open costs about 3 ms, os.rename about 4.8 ms,
os.remove about 1.2 ms, and any native call about 10-60 µs (about 58 µs per read measured).

## 1. Inventory

Size in lines. "Per frame" means called from onUpdate every frame; "tick" is the module's own rate.

| Module | Lines | Hot work | Verdict |
|---|---|---|---|
| init.lua | 2700 | reply.json poll 10 Hz, diagnostic mailbox 1 Hz, log() opens probe.log per line, targetAtCrosshair 5 Hz, world-session and party writes | split: file IO now (step 1); the rest stays Lua |
| continuous-speech.lua | 250 | reads continuous-speech/-face.json at about 25 Hz, writes continuous-control.json | C++ via step 1 (file IO) |
| speech.lua | 529 | speech-state write, speech-stream and audio-delay reads | C++ via step 1 |
| microphone.lua | 209 | command write, heard/state reads | C++ via step 1 |
| gameplay-actions.lua | 253 | companion-actions.json at 10 Hz while a lease is held | C++ via step 1 |
| phone-chat.lua | 587 | memory-chat-resets every 0.5 s, input/output/history files; a per-frame capture json round trip | step 1; the per-frame round trip is a Lua fix (perf agent) |
| invitation-readiness.lua, relationship-state.lua, auto-connect.lua | 285, 89, 382 | lease and state files | step 1 |
| service-status.lua, manager.lua | 125, 1502 | status file reads; manager-party builds companions.list twice per frame | step 1 for reads; the double build is a Lua fix |
| world-knowledge.lua, journal-history.lua | 486, 318 | the collectors, every frame | Lua redesign on main first; C++ only if still over about 5 ms/s |
| companion-actuator.lua | 1895 | per-tick geometry, GetCommandState per companion | split: tick math and game reads to C++ (step 3) |
| companions.lua | 2296 | spatial raycasts, follow decisions | split: queries to C++ (step 3) |
| companion-clearance.lua | 164 | up to 192 Overlap queries per update | C++ (step 3) |
| companion-passage.lua | 259 | carSpot queries | split (step 3) |
| facial-playback.lua | 1241 | about 70 natives per speaking actor per frame | split: the per-frame writer to C++ (step 4) |
| companion-seating.lua | 1285 | workspot scans while seating | Lua except its scans (step 4) |
| companion-chauffeur-native.lua | 410 | sample() makes 80-120 natives at 10 Hz | split (step 4) |
| companion-vehicle-native.lua | 342 | inspect makes about 30 natives per car | split (step 4) |
| loot-observer.lua | 402 | baseline pass over nearby items | split, later |
| vanilla-reactions.lua, companion-locomotion.lua, battle-observer.lua | 283, -, 88 | Override/Observe hooks that fire for every NPC | redscript filters (hook sees only mod-spawned entities), later |
| subtitles.lua, phone-chat-style.lua, phone-input.lua | 789, 554, 113 | UI Overrides; phone-chat-style scans for the open phone | redscript for the hook filter; Lua for the rest |
| mcm.lua | 1630 | a per-frame model scan | stays Lua; the scan is a Lua fix |
| UI, policy, catalogue and probe modules (notices, ui-*, character-catalog, gesture-*, face-test, diagnostics, ...) | | on demand only | stay Lua |
| knowledge-state.lua | 239 | not wired in mod/ | none |

## 2. Architecture

**Plugin.** `native/core` builds `CyberpunkConvaiNative.dll`, a RED4ext v1 plugin installed at
`red4ext/plugins/CyberpunkConvaiNative/`. Layout:

```
native/core/
  CMakeLists.txt             C++20, MSVC 2022, static CRT, /EHa, CFG; SDK pinned by commit
  src/core/                  RED4ext-free code, unit-tested headless (FileIo, Switches, Paths, Log)
  src/plugin/                Main.cpp (Supports/Query/Main), Rtti.hpp (natives helper),
                             GameAccess.hpp (player, systems, methods, properties by name),
                             Systems.hpp (CONVAI_SYSTEM self-registration)
  src/systems/<name>/        one folder per ported system (globbed by CMake)
  tests/                     convai_core_tests (links src/core only) + <name>_tests.cpp (globbed);
                             convai_plugin_host inspects the DLL without running it
  third_party/yyjson/        vendored JSON parser (MIT)
```

**Natives.** Each system registers one RTTI class with static functions in the RTTI register
callbacks (`ConvaiNative`, `ConvaiNativeIo`, ...). CET calls them as `ConvaiNativeIo.Write(a, b)`.
There is no .reds file, so a missing DLL never blocks the game from starting. Every native body
goes through `rtti::Guard`: exceptions and (with /EHa) access violations are caught, logged and
counted; three faults turn that system off for the session.

**Shared state during the migration.** Lua stays the owner of policy and entity selection. Native
code receives entities from Lua (the world policy: only mod-spawned copies get mod systems,
ordinary NPCs only talk, story NPCs nothing) and never enumerates NPCs itself. `mod/native-core.lua`
installs first in init.lua and publishes `convaiNative`: `use(system)` (cached 0.5 s, logs every
change), `fail(system, err)`, `status()`, `probe()`, `on/off(system)`.

**IO thread.** One worker thread (below normal priority) does all disk IO: atomic replace through a
POSIX-semantics rename (works while the bridge holds the old file open), coalescing of queued
writes, write-through reads, stat polling per watched file, JSON channels publish only bytes that
parse, buffered log appends (0.5 s or 64 KB). The game thread takes a mutex and copies a string:
0.1-0.4 µs per call measured headless.

**Parser.** yyjson 0.12.0 (commit `8b4a38dc`), vendored with its licence; noted in
THIRD_PARTY_NOTICES.md.

**Patch safety.** Query declares game runtime 2.31, so RED4ext refuses to load the plugin after a
game patch, and Main re-checks the runtime. Lua then finds no plugin and keeps its own path.
Natives look classes and methods up by name and treat a miss as "unavailable".

**Crash safety.** No SDK object is built at DLL load (the SDK's address resolver needs RED4ext and
shows a message box otherwise): RTTI classes are created inside the register callbacks and the
holders are `constinit`. Static CRT, no destructors under the loader lock, Guard around every
native, kill switch per system (`runtime/native-off.txt`: one system name per line, or `all`).

**Registration is all or nothing per system.** `StaticClass::Static` only records a native.
After every system recorded, `rtti::CommitAll` (post-register callback) resolves every parameter
and return type of the class against the game's RTTI (`core/Signatures.hpp`, tested headless),
builds every function, checks each kept all its parameters, and only then adds them to the class.
Any failure adds nothing, trips the system (`SystemEnabled` false, reason in `Status()` and the
log line `RTTI: <class> (<system>) not registered, system <system> is disabled ...`), and the
Lua shim stays on its own path. Why: RED4ext's `AddParam` and `SetReturnType` return false
silently for an unknown type name, which used to leave a function registered with a parameter
missing. Game-class lookups (`game::Class`, `Method`) cache hits only, so a lookup made before the
scripts loaded is retried.

**faces uses array:Float (2026-10-13).** In game 2.31 `Frame` and `Check` could not take `array:Double`, a
type this game never creates (its exe has array:Float, Int32, String and Bool only), so the commit refused
the whole faces system and facial-playback.lua kept its Lua path. Both arrays are now `array:Float`; CET
converts the Lua tables directly, and the C++ side widens them to doubles for the core (parity replay is
unchanged). Nothing in them needs more than float precision: flags, counts, weights and gains are small,
the speech vector is feature weights the game stores as Float anyway, and the clock is only compared with a
time 2.5 s ahead (2 ms resolution after 9 hours). `registration_tests.cpp` keeps a fake system with an
`array:Double` parameter to prove the check still refuses unknown types. Expected in game:
`Native core: faces=native`; if the commit still refuses it, the probe log names the type.

**Build.** `scripts/Build-NativeCore.ps1` (CMake, Visual Studio 2022 x64, RED4ext.SDK at commit
`ad727771`, a local checkout via `-SdkDirectory` or FetchContent), then ctest. Output:
`dist/native-core/CyberpunkConvaiNative.dll`.

**Packaging (after an in-game pass).** `packaging/build-release.mjs` runs Build-NativeCore.ps1 and
adds the DLL to the Runtime package at `red4ext/plugins/CyberpunkConvaiNative/`; `release.yml`
runs on a windows-2022 runner (VS 2022 and CMake are preinstalled) with the pinned SDK fetched by
CMake. RED4ext is already a Nexus requirement.

## 3. Migration order

Each step is done when its in-game check matches the Lua behaviour and its kill switch returns to
Lua mid-session.

| Step | System | Expected gain | Done-check |
|---|---|---|---|
| 1 | File IO: leases, mailboxes, continuous speech, logs (`io`) | about 30 ms/s of the 32 (each routed open becomes 1-3 native calls) | perf-probe io.open/os.rename/os.remove rows near 0; talk, leases, phone, voice and continuous speech work; native-off.txt flips back to Lua |
| 2 | Knowledge collectors | only if the Lua redesign on main still measures over about 5 ms/s | payload identical to the Lua collector for the same world |
| 3 | Companion tick and actuator, clearance queries | estimated from call counts: tens of natives per companion per tick at about 58 µs each | same follow, stop and clearance decisions on a recorded trace; no position drift |
| 4 | Gaze, faces (per-frame writer), seating scans, vehicles (chauffeur sample, inspect) | faces: about 70 calls per speaking actor per frame; chauffeur: 80-120 calls at 10 Hz | same outputs on recorded traces; no visible change in game. Faces: built on branch `port-faces` 2026-10-12 (kill switch `faces`), parity-tested, not yet checked in game |
| 5 | Redscript hook filters for the reaction/locomotion/battle hooks | per-NPC hook calls that today reach Lua | the hook fires in Lua only for mod-spawned entities |

**Could ship in 0.2:** step 1 (built and headless-tested now; needs one in-game pass). Steps 3-4
only if a system passes in game by Fri 16 Oct evening. Everything else is 0.3.

## 4. Risks and estimates

- CET calling RED4ext-registered static natives without a .reds declaration is unverified in game;
  the shim's detection (`pcall` of `ConvaiNative.CheckVersion(1)`) falls back to Lua if it fails.
- Write-through caching changes timing slightly: a read sees bridge changes up to one poll period
  later (15-250 ms by file, matching the old Lua poll rates). Log lines reach probe.log up to 0.5 s
  later and the last 0.5 s may be lost in a hard crash.
- The plugin derives the runtime folder from the game folder and the mod folder name
  (`CyberpunkConvai`); a one-time handshake at load checks it and stays on Lua if it differs.
- Estimates: step 1 done pending the in-game test; step 3 about 2 days; gaze 0.5 day; faces
  1 day; seating 0.5 day; vehicles 1-1.5 days. Steps run in parallel with the recipe below.

## 5. Parallel porting

The per-system recipe is in `docs/NATIVE_PORT_BRIEF.md`. It covers the Sonnet-lead and Haiku-task
split, the file layout, the IO module as a worked example, the parity-test pattern
(`tests/Fixture.hpp` plus a fengari recorder), the review checklist, the brief templates, and the
split and size for each system.
