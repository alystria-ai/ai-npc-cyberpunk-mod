# Native port brief (per system)

How one Lua system moves into `native/core`. Each system has one **Sonnet lead**, who owns the
judgement work and reviews, plus several **Haiku tasks** for the mechanical work. Each Haiku task
covers one function group or one file, so its result is easy to review. Size Haiku tasks for
clarity, not for a token limit. The plan and the order are in `docs/NATIVE_REWRITE_PLAN.md`.

## 1. Who does what

| Work | Model | Why |
|---|---|---|
| Measuring the system (perf-probe row, native calls per tick) and choosing what to port | Sonnet | needs judgement about the game and the frame budget |
| The native API: one batched native per tick, its arguments and return shape | Sonnet | each CET call costs 10-60 µs; the shape decides the gain |
| Game-API calls (`convai::game`, handles, entity IDs, Vector4/Quaternion, components, physics queries) | Sonnet | names, ownership and threading subtleties |
| Threading, caches across frames, invalidation on reload or session end | Sonnet | game objects only on the game thread; state shared with Lua |
| The Lua shim and its fallback; the world policy | Sonnet | the only change on main; must keep Lua as the fallback |
| The parity recorder (fengari fakes for the game API) | Sonnet | decides what "same behaviour" means |
| Data tables, constants, enum and struct mirrors | Haiku | straight transcription |
| Straight translations of pure Lua functions (math, geometry, mixing, parsing) into `core/` | Haiku | no game API; the header is given |
| Native registration boilerplate (`<Name>Natives.cpp`) from a signature list | Haiku | copies the IO template |
| Test cases from a spec or a fixture (`tests/<name>_tests.cpp`) | Haiku | mechanical once the fixture exists |
| Review of every Haiku result against section 5 | Sonnet | |
| The in-game checklist for the coordinator | Sonnet | |

Haiku repeats a recipe once a Sonnet lead has proven it on the first function group of a system.
If a Haiku task meets a game call, a `pairs()` whose order matters, coroutine use or shared state,
it stops and reports that point instead of guessing.

## 2. File layout and naming

`<name>` is the system id: lowercase, one word or hyphenated, the same in every place below
(`io`, `gaze`, `faces`, `actuator`, `clearance`, `chauffeur`, ...). `<Name>` is its PascalCase form.

| File | Contents | Written by |
|---|---|---|
| `native/core/src/systems/<name>/core/<Name>Core.hpp/.cpp` (more files allowed) | pure logic, no RED4ext include; namespace `convai::<name>` | Haiku (Sonnet writes the header first) |
| `native/core/src/systems/<name>/<Name>Natives.cpp` | `constinit rtti::StaticClass g_class("ConvaiNative<Name>")`, the natives, `CONVAI_SYSTEM(<name>, {...})` | Haiku from the template, Sonnet for game calls |
| `native/core/src/systems/<name>/<Name>Game.cpp/.hpp` (when needed) | game reads and writes through `convai::game` | Sonnet |
| `native/core/tests/<name>_tests.cpp` | `TEST(<name>_...)` cases and the fixture replay | Haiku |
| `native/core/tests/fixtures/<name>-<topic>.json` | recorded from Lua, never edited by hand | generated |
| `bridge/<module>-native.test.mjs` | the fengari recorder and checks of the shim | Sonnet |
| `mod/<module>.lua` | the shim only | Sonnet |

CMake globs all of these: `src/systems/*/core/*.cpp` goes into `convai_core` (linked by the
headless tests, no SDK), `src/systems/*/*.cpp` into the DLL, `tests/*_tests.cpp` into
`convai_core_tests`. No shared file needs editing. Add the new bridge test to the `test` script in
package.json in the same commit.

## 3. Worked example: the file IO system

| Piece | File |
|---|---|
| Pure logic (worker, queue, polling), tested headless | `src/core/FileIo.hpp/.cpp` (predates the `systems/<name>/core/` folder; new systems use that folder) |
| Natives | `src/systems/io/IoNatives.cpp` |
| Tests | `tests/io_tests.cpp`, including the parity replay `io_channels_match_the_lua_router` |
| Fixture | `tests/fixtures/io-channels.json`, recorded by `bridge/native-core.test.mjs` |
| Shim | `mod/native-core.lua` (installed by the first lines of `mod/init.lua`) |

A native, as in IoNatives.cpp:

```cpp
void Write(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, bool* aOut, int64_t)
{
    RED4ext::CString channel;
    RED4ext::CString text;
    rtti::ReadArgs(aFrame, &channel, &text);            // same order and count as registered
    rtti::Return(aOut, rtti::Guard(kSystem, [&] {       // every body inside Guard
        return GlobalFileIo().Write(ToString(channel), ToString(text));
    }, false));                                         // fallback when it faults
}
void RegisterTypes() { g_class.RegisterType(); }
void PostRegisterTypes()
{
    g_class.Static("Write", &Write, "Bool", {{"String", "channel"}, {"String", "text"}});
}
CONVAI_SYSTEM(io, {.name = "io", .registerTypes = &RegisterTypes, .postRegisterTypes = &PostRegisterTypes});
```

The Lua shim pattern for every other system (the IO shim is larger because it replaces `io.open`):

```lua
if convaiNative and convaiNative.use('<name>') then
    local ok, result = pcall(ConvaiNative<Name>.Tick, a, b)
    if ok then return result end
    convaiNative.fail('<name>', result) -- logs once; this system stays on Lua for the session
end
-- the original Lua path, unchanged
```

`convaiNative.use` re-reads the switch every 0.5 s and logs `Native core: <name>=native|lua
(reason)` on every change. Kill switch: a line `<name>` (or `all`) in `runtime/native-off.txt`, or
`convaiNative.off('<name>')` in the CET console. Three faults inside the system's natives also
switch it off.

## 4. Parity-test pattern

1. **Recorder (Sonnet).** `bridge/<module>-native.test.mjs` loads the Lua module with fengari and
   fakes for the game calls (copy the setup of `bridge/native-core.test.mjs` or the module's
   existing test). It runs a list of inputs that covers normal values, boundaries, nil or empty
   values and non-finite numbers. It writes the inputs and outputs to
   `native/core/tests/fixtures/<name>-<topic>.json` when `CONVAI_WRITE_FIXTURES=1`. Otherwise it
   asserts that the committed fixture still equals the Lua output (line endings normalized), so a
   Lua change on main that breaks parity fails `npm test`. Fixture shape:
   `{"system", "source", "cases": [{"name", "input": {...}, "output": {...}}]}`.
2. **Replay (Haiku).** `tests/<name>_tests.cpp` uses `tests/Fixture.hpp`:
   `Fixture f("<name>-<topic>"); for (auto& c : f.Cases()) { ... CHECK_NEAR(out, c.Num("output","x"), 1e-9); }`
   and ends with `CHECK(f.Count() >= N)`. Tolerance: 1e-9 for double math done in the Lua's order,
   about 1e-4 where the game hands over float32 values.
3. **In game (Sonnet writes, the coordinator runs).** Flip the switch mid-session and compare
   probe.log or perf-probe output of both paths; nothing visible may change.

## 5. Review checklist (Sonnet, on every Haiku result)

- Builds with `scripts/Build-NativeCore.ps1` with no new warnings (/W4); `convai_core_tests` and
  `plugin_host` pass; `npm test` for the touched bridge tests passes.
- `core/` files include nothing from RED4ext; nothing builds SDK objects or does RTTI lookups at
  static init (holders `constinit`, classes created in the register callbacks).
- Every native body goes through `rtti::Guard` with a safe fallback. `ReadArgs` matches the
  registered parameters in order, count and type, and the return type matches the registered
  return type string.
- Lua semantics were kept:
  - 1-based to 0-based indices, `#t` on tables with holes;
  - `math.floor` and `%` on negative numbers, integer versus float division;
  - `tostring` and number formatting;
  - nil, false and missing keys mapped to `std::optional` or flags;
  - `string.find` plain versus pattern;
  - the clamp and early-return order;
  - no dependence on the iteration order of `pairs`.
- Natives cost microseconds:
  - no disk IO and no blocking waits on the game thread;
  - no lock held across a game call;
  - no per-frame allocations that grow;
  - game objects touched only on the game thread.
- World policy: entities come in as arguments chosen by Lua; no native enumerates NPCs or picks
  targets. Only mod-spawned copies get mod systems, ordinary NPCs only talk, story NPCs nothing.
- The fixture covers the edge cases in section 4, and the replay checks every output field.
- Names follow section 2. Comments state facts, without names of other mods. Commits use plain
  messages with no AI attribution.

## 6. Brief templates

### Sonnet lead

> Port `<system>` (`mod/<module>.lua`, functions `<list>`) to the native core on branch
> `native-core` in the worktree `C:\Users\akshi\Desktop\Code Palace\cyberpunk-native`. Read
> `docs/NATIVE_PORT_BRIEF.md` and `docs/NATIVE_REWRITE_PLAN.md` first.
>
> 1. Measure: the perf-probe row and the native calls per tick. Design one batched native.
> 2. Write `core/<Name>Core.hpp` (signatures and comments), the recorder test and the fixture.
> 3. Hand the Haiku tasks listed below (one function group each, brief template 6.2). Review each
>    result against section 5.
> 4. Write the game calls, the shim and the in-game checklist.
>
> Done when the build and tests pass and the switch flips both ways (headless).
>
> Rules:
> - Commit only on `native-core` with plain messages and no AI attribution. Never push or merge.
> - Never stage `mod/diagnostics.lua`, key files or `scripts/Test-GameInput.ps1`.
> - Keep the world policy.
> - Set the model on every spawn:
>   - Haiku for the mechanical tasks and fan-outs (few agents, large batches);
>   - Sonnet for judgement work;
>   - never Opus.
>   Put this rule in every brief you write.

### Haiku task

> In the worktree `C:\Users\akshi\Desktop\Code Palace\cyberpunk-native`, write `<file>` for the
> `<name>` system of the native core.
>
> Inputs:
> - the Lua source of `<functions>` (`mod/<module>.lua` lines `<a-b>`);
> - the header `native/core/src/systems/<name>/core/<Name>Core.hpp`;
> - the template `<IoNatives.cpp | an earlier file of this system>`;
> - the fixture `<name>-<topic>.json`, if the task is tests.
>
> Translate exactly: keep the order of checks and clamps, and use doubles where the Lua uses
> numbers. No RED4ext includes in `core/`. Do not change other files.
>
> If you meet a game call, a `pairs()` whose order matters, or state shared with other Lua code,
> stop and report it.
>
> Build with `scripts/Build-NativeCore.ps1 -SdkDirectory E:\CyberpunkConvai-offload\work\native-deps\red4ext-sdk`
> and report the result. Do not commit; the lead reviews and commits.
>
> Set the model explicitly if you spawn helpers (Haiku for repeats).

## 7. Systems: split and size

Lua lines are the hot code being ported, not the whole module. C++ lines are estimates. The order
follows the plan: collectors only if the Lua redesign still costs over about 5 ms/s.

| # | System (id) | Lua source | Haiku tasks | Sonnet work | Lua lines / C++ lines |
|---|---|---|---|---|---|
| 0 | File IO (`io`) | init and the mailbox modules | done | done; in-game test pending | - / 1,900 incl. tests |
| 1 | Knowledge collectors (`collectors`), conditional | world-knowledge.lua, journal-history.lua | 3: record tables and field mirrors; the payload builder translation; tests | capture reads (quests, journal, world state), change detection shared with Lua, parity on payloads | ~500 / ~900 |
| 2 | Companion tick and actuator (`actuator`) | companion-actuator.lua tick geometry, GetCommandState | 5: constants and style tables; geometry helpers (2 groups); natives boilerplate; tests | command-state and position reads, per-companion state handed from Lua, the batched Tick native, parity on recorded traces | ~700 / ~1,200 |
| 3 | Clearance queries (`clearance`) | companion-clearance.lua (whole), companions.lua spatial raycasts | 2: profile and shape math, segment boxes; tests | physics overlap and raycast calls, the query budget, batching up to 192 queries per update | ~350 / ~600 |
| 4 | Passage car spots (`passage`) | companion-passage.lua carSpot | 2: spot geometry; tests | vehicle slot reads | ~150 / ~300 |
| 5 | Gaze (`gaze`) | companion-actuator.lua applyLook, companions.lua seatedAttention | 2: look-angle and drop math; tests | look-at component calls, release and retry ownership | ~250 / ~400 |
| 6 | Faces, the per-frame writer (`faces`) | facial-playback.lua: mixChannel, mixTargets, sampleTrack, ease, expressionPose, blinkWeight, applyFeature | 6: trait and limit tables; track sampling and easing; channel mixing; expression pose; blink; tests | the animation-feature writes per actor, the timeline handed from Lua (shared state), batching about 70 calls per actor per frame into one | ~700 / ~1,300 |
| 7 | Seating scans (`seating`) | companion-seating.lua workspot scans | 2: candidate scoring; tests | workspot and seat queries | ~300 / ~500 |
| 8 | Chauffeur sample (`chauffeur`) | companion-chauffeur-native.lua sample() | 2: sample math and thresholds; tests | 80-120 vehicle reads at 10 Hz batched into one native | ~250 / ~500 |
| 9 | Vehicle inspect (`vehicles`) | companion-vehicle-native.lua inspect | 2: record mirrors; tests | about 30 vehicle reads per car | ~200 / ~400 |
| 10 | Loot baseline (`loot`) | loot-observer.lua baseline pass | 2: item filters; tests | the nearby-item scan | ~200 / ~350 |
| 11 | Hook filters (redscript) | vanilla-reactions, companion-locomotion, battle-observer | 1: wrapper boilerplate | redscript wrappers so the hooks reach Lua only for mod-spawned entities; a .reds error must never block the game start | ~300 / ~200 reds |

Total: about 29 Haiku tasks and 11 Sonnet leads. Systems 2-10 are independent and can run in
parallel after the shared pieces (already in place: `convai::game`, `rtti`, `CONVAI_SYSTEM`,
`convaiNative.use`, `tests/Fixture.hpp`). For 0.2, only systems that pass in game by Fri 16 Oct
evening ship.
