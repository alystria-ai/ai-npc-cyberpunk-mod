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
  assert.match(result, /^Companion stance: crouch \(judy\)/);
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
    export(logs[1] .. '|' .. logs[2])`);
  assert.match(result, /crouch \(judy\)|crouch hls=Relaxed \(judy\)/);
  assert.match(result, /stand hls=Relaxed \(judy\)/);
});
