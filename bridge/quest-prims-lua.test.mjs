// The primitives of round 1 of the bond quests, the game half (mod/quest-prims.lua, docs/QUEST_PRIMITIVES.md, BOND_QUESTS.md section 21): place, pin, timer, party,
// together, seat and cast. Run on a fake game: a clock, a game clock, a world of positions whose entity rows die at every tick (the test fails if a module keeps
// one). Nothing here starts the game.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run, load, source, base, fakeCtx} from './quest-lua-fixture.mjs';

const harness = `
local Places = ${load('quest-places.lua')}
local Prims = ${load('quest-prims.lua')}
${base}
${fakeCtx}
local game = {now = 0, gameClock = 100000, rate = 30, tick = 0, vpos = {x = 0, y = 0, z = 0}, copy = nil, seated = {v = false, copy = false}, stale = false,
  spawnCalls = {}, spawnFail = 0, handles = {}, attached = {}, deleted = {}, pins = {}, pinAdds = 0, pinRemoves = 0, nextHandle = 1}
-- A row of the world is good for the tick it was made in: using it later is the mistake this fake exists to catch.
local function fresh(t)
  local gen = game.tick
  return setmetatable({}, {__index = function(_, k)
    if gen ~= game.tick then game.stale = true; error('a stale handle was used: ' .. tostring(k)) end
    return t[k]
  end})
end
local world = {
  playerPosition = function() return fresh(game.vpos) end,
  copyOf = function(key)
    if not game.copy or game.copy.profileKey ~= key then return nil end
    return fresh({kind = game.copy.kind, serial = 7, position = fresh(game.copy.position)})
  end,
  seated = function(key) return fresh({v = game.seated.v, copy = game.seated.copy}) end,
  rayDown = function() return nil end,
  pinAdd = function() game.pinAdds = game.pinAdds + 1; local id = 'pin' .. game.pinAdds; game.pins[id] = true; return id end,
  pinRemove = function(id) game.pinRemoves = game.pinRemoves + 1; game.pins[id] = nil end,
  castSpawn = function(request)
    game.spawnCalls[#game.spawnCalls + 1] = request
    if game.spawnFail > 0 then game.spawnFail = game.spawnFail - 1; return nil, 'The game could not create the character.' end
    local handle = {id = 'h' .. game.nextHandle}; game.nextHandle = game.nextHandle + 1
    game.handles[handle.id] = request
    return handle
  end,
  castLookup = function(handle)
    if not game.attached[handle.id] then return nil end
    return fresh({position = fresh(game.attached[handle.id])})
  end,
  castDelete = function(handle) game.deleted[#game.deleted + 1] = handle.id end,
}
local places = Places.new({world = world, clock = function() return game.now end, log = log})
local prims = Prims.new({places = places, world = world, clock = function() return game.now end, gameTime = function() return game.gameClock end, log = log})
local sunset = {x = 100, y = 200, z = 10, radius = 25}
local function drive(ctx, specs)
  local insts = {}
  for _, spec in ipairs(specs) do
    local def = prims.get(spec.p)
    local state = def.arm(ctx, spec, prims.env)
    if state ~= nil then insts[#insts + 1] = {def = def, spec = spec, state = state, nextAt = 0} end
  end
  return insts
end
local function advance(ctx, insts, seconds)
  for _ = 1, seconds do
    game.now = game.now + 1; game.gameClock = game.gameClock + game.rate; game.tick = game.tick + 1
    places.update()
    for _, inst in ipairs(insts) do
      if inst.def.tick and game.now >= inst.nextAt then
        inst.nextAt = game.now + (inst.def.interval or 1)
        inst.def.tick(ctx, inst.spec, inst.state, prims.env)
      end
    end
  end
end
local function stageCtx(character)
  local ctx = newCtx('pk', character)
  ctx.places = {sunset = sunset, far = {x = 5000, y = 0, z = 0, radius = 20}}
  return ctx
end
`;
const withGame = code => run(`${harness}\n${code}\nassert(not game.stale, 'a handle was kept across ticks')`);

test('place: arms a watch, arrived after the dwell, a place that is not in the stage is logged and nothing is armed', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'place', at = 'sunset', dwell = 2}, {p = 'place', at = 'nowhere'}})
assert(#insts == 1 and logged('place nowhere is not in the stage'))
game.vpos = {x = 100, y = 200, z = 10}
advance(ctx, insts, 2); assert(ctx:count('place:sunset:arrived') == 0)
advance(ctx, insts, 2); assert(ctx:count('place:sunset:arrived') == 1)
insts[1].def.disarm(ctx, insts[1].spec, insts[1].state, prims.env)
ctx:reap(); assert(not places.active())
`));

test('pin: one pin on the place, gone on arrival, gone with the ctx, none for a place that is not in the stage', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'pin', at = 'sunset'}, {p = 'place', at = 'sunset'}, {p = 'pin', at = 'nowhere'}})
assert(game.pinAdds == 1 and #insts == 2 and places.pinned(ctx, 'sunset'))
game.vpos = {x = 100, y = 200, z = 10}; advance(ctx, insts, 2)
assert(ctx:count('place:sunset:arrived') == 1 and game.pinRemoves == 1 and not places.pinned(ctx, 'sunset'), 'taken away on arrival')
local other = stageCtx(); other.pack = 'other'
drive(other, {{p = 'pin', at = 'sunset'}})
other:reap(); assert(game.pinRemoves == 2, 'and by the ctx')
`));

test('timer: timer:<id> after the seconds, in game seconds unless it says real, a timer with no seconds is not armed', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'timer', id = 'wait', seconds = 90}, {p = 'timer', id = 'real', seconds = 5, clock = 'real'}, {p = 'timer', id = 'bad'}, {p = 'timer', seconds = -1}})
assert(#insts == 2 and #ctx.timers == 2)
assert(ctx.timers[1].seconds == 90 and not ctx.timers[1].opts.real and ctx.timers[2].opts.real == true)
ctx.timers[1].fn(); assert(ctx:count('timer:wait') == 1)
ctx.timers[2].fn(); assert(ctx:count('timer:real') == 1)
`));

test('party: the copy the party already has; party:lost once when it is gone, a visitor is not a party member, and a copy never found is lost after 30 s', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'party'}})
game.copy = {profileKey = 'panam-palmer', kind = 'party', position = {x = 1, y = 1, z = 0}}
advance(ctx, insts, 20); assert(#ctx.events == 0)
game.copy = nil
advance(ctx, insts, 5); assert(ctx:count('party:lost') == 0, 'one miss is not enough')
advance(ctx, insts, 10); assert(ctx:count('party:lost') == 1)
advance(ctx, insts, 30); assert(ctx:count('party:lost') == 1, 'once')
local second = stageCtx('panam-palmer')
local more = drive(second, {{p = 'party'}})
game.copy = {profileKey = 'panam-palmer', kind = 'visitor', position = {x = 1, y = 1, z = 0}}
advance(second, more, 29); assert(second:count('party:lost') == 0)
advance(second, more, 6); assert(second:count('party:lost') == 1, 'she is a visitor, not in the party')
`));

test('together: V and the copy within the metres for the game minutes, paused while apart, broken after 90 s apart, done once', () => withGame(`
local ctx = stageCtx('panam-palmer')
game.rate = 5    -- 50 game seconds per 10 s sample
local insts = drive(ctx, {{p = 'together', id = 'tour', minutes = 10, metres = 5}})
game.copy = {profileKey = 'panam-palmer', kind = 'party', position = {x = 3, y = 0, z = 0}}
advance(ctx, insts, 60); assert(ctx:count('together:tour:done') == 0, 'about 300 of the 600 game seconds')
-- Apart for a minute: paused, then back.
game.copy.position = {x = 30, y = 0, z = 0}
advance(ctx, insts, 60); assert(ctx:count('together:tour:broken') == 0)
game.copy.position = {x = 2, y = 0, z = 0}
advance(ctx, insts, 80); assert(ctx:count('together:tour:done') == 1, 'the 600 game seconds were reached, the minute apart did not count: ' .. #ctx.events)
advance(ctx, insts, 60); assert(ctx:count('together:tour:done') == 1 and ctx:count('together:tour:broken') == 0)
-- Apart for good: broken after 90 s.
local ctx2 = stageCtx('panam-palmer')
local more = drive(ctx2, {{p = 'together', id = 'again', minutes = 600}})
advance(ctx2, more, 20)
game.copy.position = {x = 60, y = 0, z = 0}
advance(ctx2, more, 80); assert(ctx2:count('together:again:broken') == 0)
advance(ctx2, more, 20); assert(ctx2:count('together:again:broken') == 1)
advance(ctx2, more, 60); assert(ctx2:count('together:again:broken') == 1 and ctx2:count('together:again:done') == 0)
`));

test('together: the copy gone counts as apart, seated needs both seated, at needs both inside the place, a different id and breakSeconds', () => withGame(`
game.rate = 30
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'together', id = 's', minutes = 5, seated = true, breakSeconds = 3600}})
game.copy = {profileKey = 'panam-palmer', kind = 'party', position = {x = 1, y = 0, z = 0}}
advance(ctx, insts, 60); assert(ctx:count('together:s:done') == 0, 'standing is not seated')
game.seated = {v = true, copy = false}; advance(ctx, insts, 30); assert(ctx:count('together:s:done') == 0, 'only V is seated')
game.seated = {v = true, copy = true}; advance(ctx, insts, 40); assert(ctx:count('together:s:done') == 1)
local ctx2 = stageCtx('panam-palmer')
local more = drive(ctx2, {{p = 'together', id = 'p', minutes = 5, at = 'sunset', breakSeconds = 30}})
game.vpos = {x = 100, y = 200, z = 10}; game.copy.position = {x = 101, y = 200, z = 10}
advance(ctx2, more, 50); assert(ctx2:count('together:p:done') == 1, 'both inside the place')
local ctx3 = stageCtx('panam-palmer')
local third = drive(ctx3, {{p = 'together', id = 'q', minutes = 5, at = 'sunset', breakSeconds = 30}})
game.copy.position = {x = 140, y = 200, z = 10}   -- 40 m from V, outside the radius too
game.vpos = {x = 100, y = 200, z = 10}
advance(ctx3, third, 40); assert(ctx3:count('together:q:broken') == 1, 'breakSeconds')
local ctx4 = stageCtx('panam-palmer')
local fourth = drive(ctx4, {{p = 'together', minutes = 5}})
game.copy = nil; advance(ctx4, fourth, 100); assert(ctx4:count('together:together:broken') == 1, 'no copy is apart')
`));

test('seat: seat:seated when V and the copy are both seated, seat:stood when one stands, repeating', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'seat'}})
advance(ctx, insts, 5); assert(#ctx.events == 0)
game.seated = {v = true, copy = false}; advance(ctx, insts, 3); assert(#ctx.events == 0)
game.seated = {v = true, copy = true}; advance(ctx, insts, 3); assert(ctx:count('seat:seated') == 1)
advance(ctx, insts, 5); assert(ctx:count('seat:seated') == 1)
game.seated = {v = true, copy = false}; advance(ctx, insts, 3); assert(ctx:count('seat:stood') == 1)
game.seated = {v = true, copy = true}; advance(ctx, insts, 3); assert(ctx:count('seat:seated') == 2)
`));

test('cast: made when V is within 150 m, tagged, retried five times three seconds apart, arrived only once attached, deleted with the ctx', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'cast', id = 'tom', who = 'self', at = 'sunset', facing = {x = 0, y = 1}}, {p = 'cast', id = 'extra1', who = 'extra', at = 'sunset', record = 'Character.Generic'}})
assert(#insts == 2)
game.vpos = {x = 100, y = 200 + 200, z = 10}
advance(ctx, insts, 10); assert(#game.spawnCalls == 0, 'V is 200 m away: nothing is made')
game.vpos = {x = 100, y = 200 + 120, z = 10}
advance(ctx, insts, 2)
assert(#game.spawnCalls == 2, #game.spawnCalls)
local self, extra = game.spawnCalls[1], game.spawnCalls[2]
assert(self.who == 'self' and self.profileKey == 'panam-palmer' and self.id == 'pk:tom' and self.tag == 'CyberpunkConvaiQuest:pk' and self.x == 100 and self.y == 200 and self.facing.y == 1)
assert(extra.who == 'extra' and extra.record == 'Character.Generic' and extra.profileKey == nil)
advance(ctx, insts, 5); assert(ctx:count('cast:tom:arrived') == 0 and #game.spawnCalls == 2, 'not attached yet, nothing made twice')
game.attached['h1'] = {x = 100, y = 200, z = 10}
advance(ctx, insts, 3); assert(ctx:count('cast:tom:arrived') == 1 and ctx:count('cast:extra1:arrived') == 0)
advance(ctx, insts, 10); assert(ctx:count('cast:tom:arrived') == 1)
ctx:reap(); table.sort(game.deleted)
assert(#game.deleted == 2 and game.deleted[1] == 'h1' and game.deleted[2] == 'h2', 'everything made is deleted: ' .. table.concat(game.deleted, ','))
`));

test('cast: a failed spawn is tried again up to five times and then logged and given up, another character by profile key, bad casts are not armed', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'cast', id = 'judy', who = 'judy-alvarez', at = 'sunset'}, {p = 'cast', who = 'self', at = 'sunset'}, {p = 'cast', id = 'x', who = 'extra', at = 'sunset'},
  {p = 'cast', id = 'y', who = 'Bad Who', at = 'sunset'}, {p = 'cast', id = 'z', who = 'self', at = 'nowhere'}, {p = 'cast', id = 'xyz', who = 'self', x = 100, y = 210, z = 10}})
assert(#insts == 2, #insts)
game.vpos = {x = 100, y = 200, z = 10}
game.spawnFail = 100
advance(ctx, insts, 40)
assert(#game.spawnCalls == 10, 'five tries each: ' .. #game.spawnCalls)
assert(game.spawnCalls[1].profileKey == 'judy-alvarez' and game.spawnCalls[2].profileKey == 'panam-palmer')
assert(logged('spawn try 5 failed') and #ctx.tracked == 0 and #ctx.events == 0)
ctx:reap(); assert(#game.deleted == 0, 'nothing was made')
`));

test('cast: the spot is snapped to the ground first, and a world with no way to look anything up costs nothing', () => withGame(`
world.rayDown = function() return 4.5 end
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'cast', id = 'c', who = 'self', at = 'sunset'}})
game.vpos = {x = 100, y = 200, z = 10}; advance(ctx, insts, 2)
assert(game.spawnCalls[1].z == 4.5)
-- A world with nothing in it: every primitive survives it.
local empty = Prims.new({places = Places.new({world = {}, clock = function() return game.now end}), world = {}, clock = function() return game.now end})
local c2 = stageCtx('panam-palmer')
for _, spec in ipairs({{p = 'party'}, {p = 'seat'}, {p = 'together', minutes = 1}, {p = 'cast', id = 'k', who = 'self', at = 'sunset'}}) do
  local def = empty.get(spec.p)
  local state = def.arm(c2, spec, empty.env)
  if state ~= nil and def.tick then def.tick(c2, spec, state, empty.env) end
end
assert(empty.get('nope') == nil)
`));

test('ifAbsent (the bridge adds it to a stage that needs her in person): no pin and no cast while she has a copy of V, and a copy that shows up stops a cast that is waiting', () => withGame(`
-- She is not with V: the pin and the cast work as ever.
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'pin', at = 'sunset', ifAbsent = true}, {p = 'cast', id = 'rendezvous', who = 'self', at = 'sunset', ifAbsent = true, carry = true}})
assert(#insts == 2 and game.pinAdds == 1)
game.vpos = {x = 100, y = 200 + 120, z = 10}; advance(ctx, insts, 2)
assert(#game.spawnCalls == 1 and game.spawnCalls[1].profileKey == 'panam-palmer')
ctx:reap()
-- She is a party member (or an invited visitor): nothing is pinned and nothing is made, at the stage start.
game.spawnCalls, game.pinAdds = {}, 0
game.copy = {profileKey = 'panam-palmer', kind = 'party', position = {x = 1, y = 1, z = 1}}
local ctx2 = stageCtx('panam-palmer')
local insts2 = drive(ctx2, {{p = 'pin', at = 'sunset', ifAbsent = true}, {p = 'cast', id = 'rendezvous', who = 'self', at = 'sunset', ifAbsent = true}})
assert(#insts2 == 0 and game.pinAdds == 0, 'no pin, no cast state')
advance(ctx2, insts2, 5); assert(#game.spawnCalls == 0)
-- Without the flag a pack's own pin is made whatever copies there are, but a cast never moves a member of V's party away (live 31 Oct 2026: Judy stopped following V):
-- no cast state, no spawn call (the party queue's appointment form would take her out of the party), and a line in the log. A visiting copy is not a party member.
local ctx3 = stageCtx('panam-palmer')
local insts3 = drive(ctx3, {{p = 'pin', at = 'sunset'}, {p = 'cast', id = 'own', who = 'self', at = 'sunset'}})
assert(#insts3 == 1 and game.pinAdds == 1, 'the pin only: ' .. #insts3)
game.vpos = {x = 100, y = 200 + 120, z = 10}; advance(ctx3, insts3, 6)
assert(#game.spawnCalls == 0, 'a party member is not placed')
assert(logged('party, so she is not placed'), 'and it says so')
game.copy = {profileKey = 'panam-palmer', kind = 'visitor', position = {x = 1, y = 1, z = 1}}
local ctx3b = stageCtx('panam-palmer')
local insts3b = drive(ctx3b, {{p = 'cast', id = 'own', who = 'self', at = 'sunset'}})
assert(#insts3b == 1, 'a visiting copy is still cast as before')
-- A cast that was armed while she was away is not made once a copy of hers shows up (an invitation arrived first).
game.copy = nil
local ctx4 = stageCtx('panam-palmer')
local insts4 = drive(ctx4, {{p = 'cast', id = 'rendezvous', who = 'self', at = 'sunset', ifAbsent = true}})
assert(#insts4 == 1)
game.copy = {profileKey = 'panam-palmer', kind = 'visitor', position = {x = 1, y = 1, z = 1}}
game.spawnCalls = {}
game.vpos = {x = 100, y = 200 + 120, z = 10}; advance(ctx4, insts4, 6)
assert(#game.spawnCalls == 0, 'no second copy of her')
game.copy = nil; advance(ctx4, insts4, 4)
assert(#game.spawnCalls == 1, 'and when the copy is gone again she is made')
`));

test('the module is plain Lua 5.1 with no semicolon in a comment and names no other mod', () => {
  const text = source('quest-prims.lua');
  assert.ok(!/\bgoto\b|table\.unpack|bit32/.test(text));
  for (const line of text.split('\n')) assert.ok(!/--.*;/.test(line), 'no semicolon in a comment: ' + line);
});
