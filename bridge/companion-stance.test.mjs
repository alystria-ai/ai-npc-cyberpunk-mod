import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const source = readFileSync(new URL('../mod/companion-stance.lua', import.meta.url), 'utf8');
const companionsSource = readFileSync(new URL('../mod/companions.lua', import.meta.url), 'utf8');
const initSource = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const out = [];
  lua.lua_pushjsfunction(state, L => { out.push(to_jsstring(lua.lua_tostring(L, 1))); return 0; });
  lua.lua_setglobal(state, to_luastring('export'));
  const status = lauxlib.luaL_dostring(state, to_luastring(`stanceModule=(function() ${source} end)()\n${code}`));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(status, lua.LUA_OK, error);
  return out;
}

// A fake game: each npc has a stance string, and the native adapter records every call.
const harness = `
local calls, logs = {}, {}
local world = {playerCrouched = false, playerCombat = false}
local function npc(stance) return {stance = stance, combat = false, workspot = false, ignore = false} end
local native = {
  playerCrouched = function() return world.playerCrouched end,
  playerCombat = function() return world.playerCombat end,
  combat = function(n) return n.combat end,
  workspot = function(n) return n.workspot end,
  stance = function(n) return n.stance end,
  set = function(n, name)
    calls[#calls + 1] = name
    if not n.ignore then n.stance = name end
    return true
  end,
}
local function newStance(config)
  return stanceModule.new({native = native, log = function(line) logs[#logs + 1] = line end, config = config})
end
local function entry(serial, n) return {serial = serial, npc = n, profileKey = 'judy'} end
local function step(s, entries, blocker, times)
  for _ = 1, times or 1 do s.tick(0.1, entries, {}, blocker) end
end
`;

test('does nothing while V stands and nobody is held crouched', () => {
  const [calls] = run(`${harness}
    local s = newStance(); local n = npc('Stand')
    s.playerState(0)
    step(s, {entry(1, n)}, nil, 50)
    export(#calls .. ',' .. n.stance)`);
  assert.equal(calls, '0,Stand');
});

test('crouches a standing companion when V crouches and stands her when V stands', () => {
  const [result] = run(`${harness}
    local s = newStance(); local n = npc('Stand')
    s.playerState(1); step(s, {entry(1, n)})
    local afterCrouch = n.stance
    step(s, {entry(1, n)}, nil, 10)
    s.playerState(0); step(s, {entry(1, n)})
    export(afterCrouch .. ',' .. n.stance .. ',' .. table.concat(calls, '/') .. ',' .. s.holding())`);
  assert.equal(result, 'Crouch,Stand,Crouch/Stand,0');
});

test('crouch sprint and crouch dodge count as crouched; sprint, default and workspot as standing', () => {
  const [result] = run(`${harness}
    local s = newStance()
    s.playerState(11); local a = s.crouched()
    s.playerState(0); local b = s.crouched()
    s.playerState(12); local c = s.crouched()
    s.playerState(2); local d = s.crouched()
    s.playerState(4); local e = s.crouched() -- jump changes nothing
    export(tostring(a) .. tostring(b) .. tostring(c) .. tostring(d) .. tostring(e))`);
  assert.equal(result, 'truefalsetruefalsefalse');
});

test('only crouches from Stand: cover, vehicle and swim stances are left alone', () => {
  const [result] = run(`${harness}
    local s = newStance()
    local cover, car, swim = npc('Cover'), npc('Vehicle'), npc('Swim')
    s.playerState(1); step(s, {entry(1, cover), entry(2, car), entry(3, swim)}, nil, 10)
    s.playerState(0); step(s, {entry(1, cover), entry(2, car), entry(3, swim)}, nil, 10)
    export(#calls .. ',' .. cover.stance .. ',' .. car.stance .. ',' .. swim.stance)`);
  assert.equal(result, '0,Cover,Vehicle,Swim');
});

test('only stands from a crouch it set, and not over cover the AI chose', () => {
  const [result] = run(`${harness}
    local s = newStance(); local n = npc('Stand')
    s.playerState(1); step(s, {entry(1, n)})
    n.stance = 'Cover' -- the combat AI moved her into cover meanwhile
    s.playerState(0); step(s, {entry(1, n)})
    export(#calls .. ',' .. n.stance .. ',' .. s.holding())`);
  assert.equal(result, '1,Cover,0');
});

test('a companion that was already crouched by the game is never stood up by us', () => {
  const [result] = run(`${harness}
    local s = newStance(); local n = npc('Crouch')
    s.playerState(1); step(s, {entry(1, n)}, nil, 10)
    s.playerState(0); step(s, {entry(1, n)}, nil, 10)
    export(#calls .. ',' .. n.stance)`);
  assert.equal(result, '0,Crouch');
});

test('a blocker (vehicle, lift, tactic, workspot) stands her and she crouches again afterwards', () => {
  const [result] = run(`${harness}
    local s = newStance(); local n = npc('Stand')
    local reason
    local function blocker() return reason end
    s.playerState(1); step(s, {entry(1, n)}, blocker, 1)
    local a = n.stance
    reason = 'tactic'; step(s, {entry(1, n)}, blocker, 6) -- past the 0.5 s re-check
    local b = n.stance
    reason = nil; step(s, {entry(1, n)}, blocker, 6)
    export(a .. ',' .. b .. ',' .. n.stance .. ',' .. table.concat(calls, '/'))`);
  assert.equal(result, 'Crouch,Stand,Crouch,Crouch/Stand/Crouch');
});

test('combat and workspot keep her standing while V stays crouched', () => {
  const [result] = run(`${harness}
    local s = newStance(); local n = npc('Stand')
    s.playerState(1); step(s, {entry(1, n)}, nil, 1)
    n.combat = true; step(s, {entry(1, n)}, nil, 6)
    local a = n.stance
    n.combat = false; n.workspot = true; step(s, {entry(1, n)}, nil, 6)
    local b = n.stance
    n.workspot = false; world.playerCombat = true; step(s, {entry(1, n)}, nil, 6)
    local c = n.stance
    world.playerCombat = false; step(s, {entry(1, n)}, nil, 6)
    export(a .. ',' .. b .. ',' .. c .. ',' .. n.stance)`);
  assert.equal(result, 'Stand,Stand,Stand,Crouch');
});

test('re-issues a crouch the AI reset at most three times, then leaves her alone', () => {
  const [result] = run(`${harness}
    local s = newStance(); local n = npc('Stand'); n.ignore = true -- the game keeps her standing
    s.playerState(1); step(s, {entry(1, n)}, nil, 200)
    export(#calls .. ',' .. n.stance .. ',' .. (s.holding()))`);
  // one issue plus three re-issues; none after that
  assert.equal(result, '4,Stand,1');
});

test('a stance call that raises an error is not repeated every sync: one try per crouch of V\'s, a fresh one for the next', () => {
  const [result] = run(`${harness}
    local origSet = native.set
    native.set = function(n, name) if n.fail then calls[#calls + 1] = name; return false, 'boom' end return origSet(n, name) end
    local s = newStance(); local n = npc('Stand'); n.fail = true
    s.playerState(1); step(s, {entry(1, n)}, nil, 60)   -- six seconds of crouching
    local during = #calls
    local failures = 0; for _, line in ipairs(logs) do if line:find('crouch failed', 1, true) then failures = failures + 1 end end
    s.playerState(0); step(s, {entry(1, n)}, nil, 5)
    n.fail = false
    s.playerState(1); step(s, {entry(1, n)}, nil, 5)   -- the next crouch gets its own attempt, which now works
    export(during .. ',' .. failures .. ',' .. n.stance .. ',' .. s.holding())`);
  assert.equal(result, '1,1,Crouch,1');
});

test('a dismissed companion is dropped without a native call', () => {
  const [result] = run(`${harness}
    local s = newStance(); local n = npc('Stand')
    s.playerState(1); step(s, {entry(1, n)})
    local before = #calls
    step(s, {}, nil, 10)
    export(before .. ',' .. #calls .. ',' .. s.holding())`);
  assert.equal(result, '1,1,0');
});

test('while V stands the check costs no native read; while crouched reads are throttled to every 0.5 s', () => {
  const [result] = run(`${harness}
    local reads = 0
    local base = native.stance
    native.stance = function(n) reads = reads + 1; return base(n) end
    local s = newStance(); local n = npc('Stand')
    s.playerState(0); step(s, {entry(1, n)}, nil, 100)
    local idle = reads
    s.playerState(1); step(s, {entry(1, n)}, nil, 100) -- 10 s
    export(idle .. ',' .. (reads <= 40 and 'ok' or reads))`);
  assert.equal(result, '0,ok');
});

test('log lines read Companion stance', () => {
  const [result] = run(`${harness}
    local s = newStance(); local n = npc('Stand')
    s.playerState(1); step(s, {entry(1, n)})
    export(logs[1])`);
  assert.match(result, /^Companion stance: crouch issued via stance.* \(judy\)$/);
});

test('install registers one ObserveAfter hook on PlayerPuppet and forwards the state', () => {
  const [result] = run(`${harness}
    local registered = {}
    ObserveAfter = function(class, method, fn) registered[#registered + 1] = {class, method, fn} end
    local s = newStance()
    local first = stanceModule.install(s, function() end)
    local second = stanceModule.install(s, function() end)
    registered[1][3](nil, 1)
    export(#registered .. ',' .. registered[1][1] .. ',' .. registered[1][2] .. ',' .. tostring(first) .. tostring(second) .. ',' .. tostring(s.crouched()))`);
  assert.equal(result, '1,PlayerPuppet,OnLocomotionStateChanged,truetrue,true');
});

test('a failing hook install is logged and not fatal', () => {
  const [result] = run(`${harness}
    ObserveAfter = function() error('no such class') end
    local s = newStance()
    export(tostring(stanceModule.install(s, function(line) logs[#logs + 1] = line end)) .. ',' .. (logs[1] or ''))`);
  assert.match(result, /^false,Companion stance hook failed/);
});

test('wiring: companions.lua ticks it from the 10 Hz update and never loads it by dofile; init installs the hook once', () => {
  assert.doesNotMatch(companionsSource, /dofile\('companion-stance\.lua'\)/);
  assert.match(companionsSource, /M\.stance\.tick,step,ready,player,stanceBlocker/);
  assert.match(companionsSource, /M\.stance\.abandon/);
  assert.match(initSource, /dofile, 'companion-stance\.lua'/);
  assert.equal([...initSource.matchAll(/stanceModule\.install\(/g)].length, 1);
  // Nothing in the module runs per frame.
  assert.doesNotMatch(source, /registerForEvent/);
});

test('a stand is read back and re-issued while the stance still reads Crouch, then given up after three tries', () => {
  const [result] = run(`${harness}
    local s = newStance(); local n = npc('Stand')
    s.playerState(1); step(s, {entry(1, n)}, nil, 10)
    n.ignore = true -- the game ignores the stand requests
    s.playerState(0); step(s, {entry(1, n)}, nil, 200)
    local stuck = n.stance
    n.ignore = false
    step(s, {entry(1, n)}, nil, 50)
    local count = 0
    for _, c in ipairs(calls) do if c == 'Stand' then count = count + 1 end end
    export(stuck .. ',' .. count .. ',' .. tostring(s.holds(1)) .. ',' .. tostring(logs[#logs]:find('stand not kept') ~= nil))`);
  // original stand plus three re-issues, then stopped
  assert.equal(result, 'Crouch,4,false,true');
});

test('a stand that takes effect on the first try is not repeated and stops reading the stance', () => {
  const [result] = run(`${harness}
    local reads = 0
    local base = native.stance
    native.stance = function(n) reads = reads + 1; return base(n) end
    local s = newStance(); local n = npc('Stand')
    s.playerState(1); step(s, {entry(1, n)}, nil, 5)
    s.playerState(0); step(s, {entry(1, n)}, nil, 20)
    local after = reads
    step(s, {entry(1, n)}, nil, 200)
    export(table.concat(calls, '/') .. ',' .. n.stance .. ',' .. tostring(s.holds(1)) .. ',' .. (reads == after and 'quiet' or 'reading'))`);
  assert.equal(result, 'Crouch/Stand,Stand,false,quiet');
});

test('V crouching again before the stand took effect adopts the crouch that is still there', () => {
  const [result] = run(`${harness}
    local s = newStance(); local n = npc('Stand')
    s.playerState(1); step(s, {entry(1, n)}, nil, 3)
    n.ignore = true
    s.playerState(0); step(s, {entry(1, n)}, nil, 1) -- stand issued, ignored: still Crouch
    s.playerState(1); step(s, {entry(1, n)}, nil, 1)
    local held = s.holding()
    n.ignore = false
    s.playerState(0); step(s, {entry(1, n)}, nil, 3)
    export(held .. ',' .. n.stance .. ',' .. table.concat(calls, '/'))`);
  assert.equal(result, '1,Stand,Crouch/Stand/Stand');
});

test('holds() is true while crouched and while a stand is unconfirmed, and gestures read it', () => {
  const [result] = run(`${harness}
    local s = newStance(); local n = npc('Stand')
    local a = tostring(s.holds(1))
    s.playerState(1); step(s, {entry(1, n)}, nil, 2)
    local b = tostring(s.holds(1))
    s.playerState(0); step(s, {entry(1, n)}, nil, 1)
    local c = tostring(s.holds(1)) -- stand issued, not yet read back
    step(s, {entry(1, n)}, nil, 30)
    export(a .. ',' .. b .. ',' .. c .. ',' .. tostring(s.holds(1)))`);
  assert.equal(result, 'false,true,true,false');
  assert.match(companionsSource, /crouched=stance~=nil and \(stance\.crouched\(\) or stance\.holds\(entry\.serial\)\)/);
});

test('a copy in a workspot while V crouches waits, says why once, and crouches when the workspot ends', () => {
  const [result] = run(`${harness}
    local s = newStance(); local n = npc('Stand'); n.workspot = true
    s.playerState(1); step(s, {entry(1, n)}, nil, 20)
    local waiting = n.stance .. '/' .. #calls
    n.workspot = false; step(s, {entry(1, n)}, nil, 6)
    local waits = 0
    for _, l in ipairs(logs) do if l:find('crouch waiting - workspot', 1, true) then waits = waits + 1 end end
    export(waiting .. ',' .. n.stance .. ',' .. waits)`);
  assert.equal(result, 'Stand/0,Crouch,1');
});

test('log lines for crouch and stand carry the high-level state when the adapter reads it', () => {
  const [result] = run(`${harness}
    native.highLevel = function() return 'Relaxed' end
    local s = newStance(); local n = npc('Stand')
    s.playerState(1); step(s, {entry(1, n)}, nil, 1)
    step(s, {entry(1, n)}, nil, 20)
    s.playerState(0); step(s, {entry(1, n)}, nil, 20)
    export(table.concat(logs, '|'))`);
  assert.match(result, /crouch issued via stance stance=Crouch hls=Relaxed \(judy\)/);
  assert.match(result, /stand issued via stance stance=Stand hls=Relaxed \(judy\)/);
});

// ---- High-level state methods (2026-10-14): Relaxed shows no crouch, so Stealth is raised first ----

// A fake game where the crouched pose only shows in the listed high-level states, as the locomotion
// wrappers suggest: the head slot is 1.7 m above her feet standing and 1.1 m crouched.
const hlsHarness = `${harness}
local seen = {Stealth = true, Alerted = true}
local function npc2(over)
  local n = npc('Stand'); n.hls = 'Relaxed'; n.ignoreHls = false
  for k, v in pairs(over or {}) do n[k] = v end
  return n
end
native.highLevel = function(n) return n.hls end
native.setHighLevel = function(n, name)
  calls[#calls + 1] = 'hls:' .. name
  if not n.ignoreHls then n.hls = name end
  return true
end
local headReads = 0
native.headRise = function(n)
  headReads = headReads + 1
  if n.noHead then return nil end
  return (n.stance == 'Crouch' and seen[n.hls]) and 1.1 or 1.7
end
local function count(prefix)
  local c = 0
  for _, l in ipairs(logs) do if l:find(prefix, 1, true) then c = c + 1 end end
  return c
end
`;

test('a crouch outside combat raises Stealth first, the stance call follows after a short gap, and the head confirms it', () => {
  const [result] = run(`${hlsHarness}
    local s = newStance(); local n = npc2()
    s.playerState(1)
    step(s, {entry(1, n)}, nil, 1)
    local first = table.concat(calls, '/') .. ':' .. n.stance
    step(s, {entry(1, n)}, nil, 30)
    export(first .. '|' .. table.concat(calls, '/') .. '|' .. n.hls .. '|' .. n.stance .. '|' .. count('crouch confirmed via stealth: head down 0.60 m'))`);
  // tick 1: only the high-level call; the stance call comes on a later tick, never in the same frame
  assert.equal(result, 'hls:Stealth:Stand|hls:Stealth/Crouch|Stealth|Crouch|1');
});

test('standing restores Relaxed after the stance call, reads both back and confirms with the head', () => {
  const [result] = run(`${hlsHarness}
    local s = newStance(); local n = npc2()
    s.playerState(1); step(s, {entry(1, n)}, nil, 30)
    s.playerState(0); step(s, {entry(1, n)}, nil, 1)
    local first = table.concat(calls, '/') .. ':' .. n.stance .. '/' .. n.hls
    step(s, {entry(1, n)}, nil, 30)
    export(first .. '|' .. table.concat(calls, '/') .. '|' .. n.stance .. '/' .. n.hls .. '|' .. tostring(s.holds(1)) .. '|' .. count('stand confirmed') .. '|' .. count('head back'))`);
  assert.equal(result, 'hls:Stealth/Crouch/Stand:Stand/Stealth|hls:Stealth/Crouch/Stand/hls:Relaxed|Stand/Relaxed|false|1|1');
});

test('when Stealth shows no crouch the head sees it and Alerted is tried, then restored on standing', () => {
  const [result] = run(`${hlsHarness}
    seen = {Alerted = true}
    local s = newStance(); local n = npc2()
    s.playerState(1); step(s, {entry(1, n)}, nil, 60)
    local crouched = table.concat(calls, '/') .. '|' .. n.hls
    s.playerState(0); step(s, {entry(1, n)}, nil, 40)
    export(crouched .. '|' .. n.hls .. '|' .. n.stance .. '|' .. count('NOT visible via stealth') .. count('trying alerted') .. count('confirmed via alerted: head down 0.60 m'))`);
  assert.equal(result, 'hls:Stealth/Crouch/hls:Alerted|Alerted|Relaxed|Stand|111');
});

test('when no method shows a crouch she gets Relaxed back, says so, and still stands normally', () => {
  const [result] = run(`${hlsHarness}
    seen = {}
    local s = newStance(); local n = npc2()
    s.playerState(1); step(s, {entry(1, n)}, nil, 120)
    local mid = n.hls .. '/' .. n.stance
    local reads = headReads
    step(s, {entry(1, n)}, nil, 100)
    local quiet = reads == headReads
    s.playerState(0); step(s, {entry(1, n)}, nil, 30)
    export(mid .. '|' .. tostring(quiet) .. '|' .. n.hls .. '/' .. n.stance .. '|' .. count('no method left') .. '|' .. s.holding())`);
  assert.equal(result, 'Relaxed/Crouch|true|Relaxed/Stand|1|0');
});

test('a high-level state the game chose is never changed, raised or restored', () => {
  const [result] = run(`${hlsHarness}
    local s = newStance(); local a, b = npc2({hls = 'Stealth'}), npc2({hls = 'Alerted'})
    s.playerState(1); step(s, {entry(1, a), entry(2, b)}, nil, 40)
    s.playerState(0); step(s, {entry(1, a), entry(2, b)}, nil, 40)
    local hlsCalls = 0
    for _, c in ipairs(calls) do if c:find('hls:', 1, true) then hlsCalls = hlsCalls + 1 end end
    export(hlsCalls .. ',' .. a.hls .. ',' .. b.hls .. ',' .. a.stance .. ',' .. b.stance)`);
  assert.equal(result, '0,Stealth,Alerted,Stand,Stand');
});

test('combat taking the high-level state while she is crouched is not undone when V stands', () => {
  const [result] = run(`${hlsHarness}
    local s = newStance(); local n = npc2()
    s.playerState(1); step(s, {entry(1, n)}, nil, 30)
    n.hls = 'Combat'; n.combat = true
    step(s, {entry(1, n)}, nil, 10)
    s.playerState(0); step(s, {entry(1, n)}, nil, 30)
    local hlsCalls = {}
    for _, c in ipairs(calls) do if c:find('hls:', 1, true) then hlsCalls[#hlsCalls + 1] = c end end
    export(table.concat(hlsCalls, '/') .. '|' .. n.hls .. '|' .. tostring(s.holds(1)))`);
  assert.equal(result, 'hls:Stealth|Combat|false');
});

test('the game resetting the raised state to Relaxed is raised again three times, then left with an explanation', () => {
  const [result] = run(`${hlsHarness}
    local s = newStance(); local n = npc2()
    s.playerState(1)
    for _ = 1, 400 do n.hls = 'Relaxed'; step(s, {entry(1, n)}, nil, 1) end
    local raises = 0
    for _, c in ipairs(calls) do if c == 'hls:Stealth' then raises = raises + 1 end end
    export(raises .. '|' .. count('keeps resetting hls') .. '|' .. n.hls)`);
  // the first raise plus three re-raises
  assert.equal(result, '4|1|Relaxed');
});

test('a Relaxed restore the game ignores is re-issued three times and then reported', () => {
  const [result] = run(`${hlsHarness}
    local s = newStance(); local n = npc2()
    s.playerState(1); step(s, {entry(1, n)}, nil, 30)
    n.ignoreHls = true
    s.playerState(0); step(s, {entry(1, n)}, nil, 200)
    local relaxed = 0
    for _, c in ipairs(calls) do if c == 'hls:Relaxed' then relaxed = relaxed + 1 end end
    export(relaxed .. '|' .. n.stance .. '|' .. tostring(s.holds(1)) .. '|' .. count('stand not kept by the game'))`);
  assert.equal(result, '4|Stand|false|1');
});

test('V crouching again before Relaxed was restored keeps ownership, so the next stand restores it', () => {
  const [result] = run(`${hlsHarness}
    local s = newStance(); local n = npc2()
    s.playerState(1); step(s, {entry(1, n)}, nil, 30)
    s.playerState(0); step(s, {entry(1, n)}, nil, 1) -- stance Stand sent, Relaxed not yet
    s.playerState(1); step(s, {entry(1, n)}, nil, 30)
    local mid = n.hls .. '/' .. n.stance
    s.playerState(0); step(s, {entry(1, n)}, nil, 40)
    export(mid .. '|' .. n.hls .. '/' .. n.stance .. '|' .. s.holding() .. '|' .. tostring(s.holds(1)))`);
  assert.equal(result, 'Stealth/Crouch|Relaxed/Stand|0|false');
});

test('a blocker stands her and restores Relaxed, and she is raised and crouched again afterwards', () => {
  const [result] = run(`${hlsHarness}
    local s = newStance(); local n = npc2()
    local reason
    local function blocker() return reason end
    s.playerState(1); step(s, {entry(1, n)}, blocker, 30)
    reason = 'vehicle'; step(s, {entry(1, n)}, blocker, 30)
    local blocked = n.hls .. '/' .. n.stance
    reason = nil; step(s, {entry(1, n)}, blocker, 30)
    export(blocked .. '|' .. n.hls .. '/' .. n.stance)`);
  assert.equal(result, 'Relaxed/Stand|Stealth/Crouch');
});

test('without a head reading the blackboards confirm the crouch and nothing is escalated', () => {
  const [result] = run(`${hlsHarness}
    local s = newStance(); local n = npc2({noHead = true})
    s.playerState(1); step(s, {entry(1, n)}, nil, 60)
    export(n.hls .. '/' .. n.stance .. '|' .. count('by the blackboards only') .. '|' .. count('NOT visible') .. '|' .. count('trying alerted'))`);
  assert.equal(result, 'Stealth/Crouch|1|0|0');
});

test('an adapter without a high-level setter keeps the stance-only behaviour', () => {
  const [result] = run(`${hlsHarness}
    native.setHighLevel = nil
    local s = newStance(); local n = npc2()
    s.playerState(1); step(s, {entry(1, n)}, nil, 1)
    export(table.concat(calls, '/') .. '|' .. n.hls .. '|' .. (logs[1]:find('via stance', 1, true) and 'stance' or logs[1]))`);
  assert.equal(result, 'Crouch|Relaxed|stance');
});

test('the checks stay bounded: a long crouch reads the head only until it is confirmed', () => {
  const [result] = run(`${hlsHarness}
    local reads = 0
    local base = native.stance
    native.stance = function(n) reads = reads + 1; return base(n) end
    local s = newStance(); local n = npc2()
    s.playerState(1); step(s, {entry(1, n)}, nil, 600) -- 60 s
    export(headReads .. ',' .. (reads <= 140 and 'ok' or reads))`);
  // one baseline read and one confirming read
  assert.equal(result, '2,ok');
});

test('the native adapter raises the state with NPCPuppet.ChangeHighLevelState and reads the Head slot', () => {
  assert.match(source, /NPCPuppet\.ChangeHighLevelState\(npc, Enum\.new\('gamedataNPCHighLevelState', name\)\)/);
  assert.match(source, /GetSlotTransform\(CName\.new\('Head'\)\)/);
  assert.match(source, /methods = \{'stealth', 'alerted'\}/);
  // Only the 10 Hz companion tick and the one blackboard observer drive it.
  assert.doesNotMatch(source, /registerForEvent|onUpdate/);
});
