// Places of a bond quest, the game half (mod/quest-places.lua, docs/QUEST_PRIMITIVES.md): the geometry, the watch that says arrived and left, the one downward
// ray that snaps a point to the ground, and the map pin of a meeting point. Run on a fake game (a clock, a position, a pin system); nothing here starts the game.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run, load, source, base, fakeCtx} from './quest-lua-fixture.mjs';

const harness = `
local M = ${load('quest-places.lua')}
${base}
${fakeCtx}
local game = {now = 0, pos = {x = 0, y = 0, z = 0}, reads = 0, rayCalls = 0, rayZ = nil, rayError = false, pins = {}, pinAdds = 0, pinRemoves = {}, nextPin = 1,
  pinFails = false, pinError = false, districtReads = 0, district = nil}
local world = {
  playerPosition = function() game.reads = game.reads + 1; return {x = game.pos.x, y = game.pos.y, z = game.pos.z} end,
  rayDown = function(x, y, top, bottom)
    game.rayCalls = game.rayCalls + 1; game.rayArgs = {x, y, top, bottom}
    if game.rayError then error('no spatial system') end
    return game.rayZ
  end,
  pinAdd = function(x, y, z)
    if game.pinError then error('no mappin system') end
    if game.pinFails then return nil end
    local id = 'pin' .. game.nextPin; game.nextPin = game.nextPin + 1
    game.pinAdds = game.pinAdds + 1; game.pins[id] = {x, y, z}
    return id
  end,
  pinRemove = function(id) game.pinRemoves[#game.pinRemoves + 1] = id; game.pins[id] = nil end,
  district = function() game.districtReads = game.districtReads + 1; return game.district end,
}
local places = M.new({world = world, clock = function() return game.now end, log = log})
local function advance(seconds) for _ = 1, seconds do game.now = game.now + 1; places.update() end end
local sunset = {x = 100, y = 200, z = 10, radius = 25, district = 'Badlands'}
local function pinCount() local n = 0 for _ in pairs(game.pins) do n = n + 1 end return n end
`;
const withGame = code => run(`${harness}\n${code}`);

test('inside: flat distance within the radius, a generous height band, a slack for leaving', () => withGame(`
assert(M.inside(sunset, {x = 100, y = 200, z = 10}))
assert(M.inside(sunset, {x = 124, y = 200, z = 10}) and not M.inside(sunset, {x = 126, y = 200, z = 10}), 'the radius')
assert(M.inside(sunset, {x = 100, y = 200, z = 10 + 25}) and not M.inside(sunset, {x = 100, y = 200, z = 10 + 26}), 'a band as wide as the radius')
assert(M.inside({x = 0, y = 0, z = 0, radius = 3}, {x = 0, y = 0, z = 12}) and not M.inside({x = 0, y = 0, z = 0, radius = 3}, {x = 0, y = 0, z = 13}), 'at least 12 m')
assert(not M.inside({x = 0, y = 0, z = 0, radius = 500}, {x = 0, y = 0, z = 61}), 'at most 60 m')
assert(M.inside({x = 0, y = 0, z = 0, radius = 10, zBand = 40}, {x = 0, y = 0, z = 40}), 'a band of the place')
assert(not M.inside(sunset, {x = 126, y = 200, z = 10}) and M.inside(sunset, {x = 126, y = 200, z = 10}, 1.15), 'slack')
for _, bad in ipairs({{}, {x = 1, y = 1, z = 1}, {x = 1, y = 1, z = 1, radius = 0}, {x = 'a', y = 1, z = 1, radius = 5}, {x = 1, y = 1, z = 1, radius = 5000}}) do
  assert(not M.inside(bad, {x = 1, y = 1, z = 1}) and not M.valid(bad))
end
assert(not M.inside(sunset, nil) and not M.inside(sunset, {x = 1, y = 'q', z = 1}))
`));

test('nothing watched or pinned: update is a nil check (no position read, no ray, no district read)', () => withGame(`
advance(120)
assert(game.reads == 0 and game.rayCalls == 0 and game.districtReads == 0)
assert(not places.active())
`));

test('arrived once after the dwell, left once after that, then the watch is over and costs nothing', () => withGame(`
local ctx = newCtx('p')
game.rayZ = nil
places.watch(ctx, 'sunset', sunset, {dwell = 3})
game.pos = {x = 100, y = 200, z = 10}
advance(2); assert(ctx:count('place:sunset:arrived') == 0, 'the dwell has not passed')
advance(3); assert(ctx:count('place:sunset:arrived') == 1)
advance(5); assert(ctx:count('place:sunset:arrived') == 1, 'once')
game.pos = {x = 126, y = 200, z = 10}
advance(2); assert(ctx:count('place:sunset:left') == 0, 'inside the leaving slack')
game.pos = {x = 140, y = 200, z = 10}
advance(2); assert(ctx:count('place:sunset:left') == 1)
local reads = game.reads
advance(60); assert(game.reads == reads, 'a finished watch reads nothing')
assert(ctx:count('place:sunset:left') == 1 and not places.active())
`));

test('a visit shorter than the dwell does not count, and leaving before arriving says nothing', () => withGame(`
local ctx = newCtx('p')
places.watch(ctx, 'sunset', sunset, {dwell = 5})
game.pos = {x = 100, y = 200, z = 10}; advance(3)
game.pos = {x = 220, y = 200, z = 10}; advance(3)
game.pos = {x = 100, y = 200, z = 10}; advance(3)
assert(#ctx.events == 0, table.concat(ctx.events, ','))
advance(4); assert(ctx:count('place:sunset:arrived') == 1)
`));

test('reads: every 5 s far away (0.2 Hz), every second within 300 m or in the place district, counted over simulated minutes', () => withGame(`
local ctx = newCtx('p')
places.watch(ctx, 'sunset', sunset, {})
game.pos = {x = 3000, y = 200, z = 10}
advance(60); local far = game.reads
assert(far >= 11 and far <= 13, 'far: ' .. far)
game.district = {district = 'Badlands'}
local before = game.reads
advance(60); assert(game.reads - before >= 58 and game.reads - before <= 62, 'the district: ' .. (game.reads - before))
game.district = nil; game.pos = {x = 100 + 280, y = 200, z = 10}
-- the district answer is cached for 5 s, so allow a few seconds for the change to be seen
advance(10)
before = game.reads
advance(60); assert(game.reads - before >= 58, 'near: ' .. (game.reads - before))
game.pos = {x = 100 + 900, y = 200, z = 10}
advance(10)
before = game.reads
advance(120); assert(game.reads - before <= 26, 'far again: ' .. (game.reads - before))
assert(game.districtReads <= game.now / 5 + 2, 'the district is read at most every 5 s: ' .. game.districtReads .. ' in ' .. game.now)
`));

test('a place with no district or a failed position read still works: a bad read waits 5 s and tries again', () => withGame(`
local ctx = newCtx('p')
local plain = {x = 0, y = 0, z = 0, radius = 10}
places.watch(ctx, 'p', plain, {})
local fails = true
world.playerPosition = function() game.reads = game.reads + 1; if fails then return nil end return {x = 0, y = 0, z = 0} end
advance(30); assert(game.reads >= 5 and game.reads <= 8, game.reads)
fails = false; advance(6); assert(ctx:count('place:p:arrived') == 1)
`));

test('the ground: one ray from 3 m above to 20 m below, a hit at or below z + 0.5 is the floor, anything else keeps the stored z, cached by position', () => withGame(`
game.rayZ = 7.25
local snapped = places.snap(sunset)
assert(snapped.z == 7.25 and sunset.z == 10, 'the stored place is not changed')
assert(game.rayArgs[1] == 100 and game.rayArgs[2] == 200 and game.rayArgs[3] == 13 and game.rayArgs[4] == -10, table.concat(game.rayArgs, ','))
places.snap(sunset); assert(game.rayCalls == 1, 'cached')
game.rayZ = 10.6  -- a roof above the floor
assert(places.snap({x = 1, y = 1, z = 10, radius = 5}).z == 10)
game.rayZ = 10.5; assert(places.snap({x = 2, y = 1, z = 10, radius = 5}).z == 10.5)
game.rayZ = -50;  assert(places.snap({x = 3, y = 1, z = 10, radius = 5}).z == 10, 'too far down')
game.rayZ = nil;  assert(places.snap({x = 4, y = 1, z = 10, radius = 5}).z == 10)
game.rayZ = 'x';  assert(places.snap({x = 5, y = 1, z = 10, radius = 5}).z == 10)
game.rayError = true; assert(places.snap({x = 6, y = 1, z = 10, radius = 5}).z == 10, 'a raising ray is guarded')
-- The watch uses the snapped point.
game.rayError = false; game.rayZ = 0
local ctx = newCtx('p')
places.watch(ctx, 'low', {x = 50, y = 50, z = 3, radius = 10}, {})
game.pos = {x = 50, y = 50, z = 0}; advance(2)
assert(ctx:count('place:low:arrived') == 1)
`));

test('a pin: registered once with one handle, taken away on arrival and by the ctx on every other exit', () => withGame(`
game.rayZ = nil
local ctx = newCtx('p')
places.pin(ctx, 'sunset', sunset); places.pin(ctx, 'sunset', sunset)
assert(game.pinAdds == 1 and pinCount() == 1 and places.pinned(ctx, 'sunset'), 'one handle per pin')
assert(game.pins.pin1[1] == 100 and game.pins.pin1[3] == 10)
ctx:on('place:sunset:arrived', function() places.unpin(ctx, 'sunset') end)
places.watch(ctx, 'sunset', sunset, {})
game.pos = {x = 100, y = 200, z = 10}; advance(2)
assert(pinCount() == 0 and #game.pinRemoves == 1 and not places.pinned(ctx, 'sunset'), 'gone on arrival')
-- A second pin goes with the ctx when the stage ends.
places.pin(ctx, 'other', {x = 9, y = 9, z = 9, radius = 5})
assert(pinCount() == 1)
ctx:reap(); assert(pinCount() == 0 and #game.pinRemoves == 2)
places.unpin(ctx, 'other'); assert(#game.pinRemoves == 2, 'taking a pin away twice asks the system once')
`));

test('a load: the pins are dead, their handles are dropped without asking the system, and the stage registers them again', () => withGame(`
local ctx = newCtx('p')
places.pin(ctx, 'sunset', sunset)
assert(game.pinAdds == 1)
places.pinsLost()
ctx:reap()
assert(#game.pinRemoves == 0, 'the system was not asked to remove a dead pin')
local again = newCtx('p')
places.pin(again, 'sunset', sunset)
assert(game.pinAdds == 2 and places.pinned(again, 'sunset'), 'registered again from the saved stage')
-- forget: nothing is kept at all.
places.watch(again, 'sunset', sunset, {})
places.forget()
assert(not places.active() and #game.pinRemoves == 0)
`));

test('a pin the game refuses is tried again every 5 s up to five times, a raising system is guarded, too many pins are refused', () => withGame(`
game.pinFails = true
local ctx = newCtx('p')
places.pin(ctx, 'sunset', sunset)
assert(game.pinAdds == 0 and not places.pinned(ctx, 'sunset'))
advance(12); assert(game.pinAdds == 0)
game.pinFails = false; advance(6)
assert(game.pinAdds == 1 and places.pinned(ctx, 'sunset'), 'registered at a retry')
-- Always failing: it gives up after five tries and says so.
game.pinFails = true
places.pin(ctx, 'second', {x = 1, y = 1, z = 1, radius = 5})
advance(60); assert(logged('could not be registered'))
-- A system that raises.
game.pinError = true
places.pin(ctx, 'third', {x = 2, y = 2, z = 2, radius = 5}); advance(30)
-- Capped.
game.pinError = false; game.pinFails = false
local count = 0
for i = 1, 10 do if places.pin(ctx, 'many' .. i, {x = i, y = 1, z = 1, radius = 5}) then count = count + 1 end end
assert(count <= 4, count)
`));

test('bad input: an invalid place, an empty id and a watch limit are refused without a call', () => withGame(`
local ctx = newCtx('p')
assert(places.watch(ctx, 'x', {x = 1}, {}) == nil and places.watch(ctx, '', sunset, {}) == nil and places.pin(ctx, 'x', {}) == nil)
for i = 1, 16 do assert(places.watch(ctx, 'w' .. i, sunset, {})) end
assert(places.watch(ctx, 'w17', sunset, {}) == nil and logged('too many watches'))
local w = places.watch(ctx, 'w1', sunset, {}); assert(w, 'the same watch again is the same watch')
ctx:reap(); assert(not places.active())
`));

test('the module file is plain Lua 5.1 (the game runs LuaJIT) and has no semicolon in its comments', () => {
  const text = source('quest-places.lua');
  assert.ok(!/\bgoto\b|table\.unpack|bit32/.test(text));
  for (const line of text.split('\n')) assert.ok(!/--.*;/.test(line), 'no semicolon in a comment: ' + line);
});
