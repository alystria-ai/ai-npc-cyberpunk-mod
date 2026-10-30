// The action primitives of the bond quests, the game half (mod/quest-prims-action.lua and mod/quest-world-action.lua, docs/QUEST_PRIMITIVES.md, BOND_QUESTS.md section 21):
// squad, hostage and escortee. Run on a fake game: a clock, a game clock, a world of positions and actors whose rows die at every tick (the test fails if a module keeps
// one), and a call counter on every world function. The natives are run too, on a fake of the game's own objects. Nothing here starts the game.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run, load, source, base, fakeCtx} from './quest-lua-fixture.mjs';

const harness = `
local Places = ${load('quest-places.lua')}
local Prims = ${load('quest-prims.lua')}
local Action = ${load('quest-prims-action.lua')}
local Ambush = ${load('revenge-ambush.lua')}
${base}
${fakeCtx}
local game = {now = 0, gameClock = 100000, rate = 1, tick = 0, vpos = {x = 0, y = 0, z = 0}, stale = false, hidden = true, calls = {}, order = {},
  actors = {}, nextActor = 1, deleted = {}, spawnRequests = {}, spawnFail = 0, verifyFail = {}, armCombat = true, armOk = true, configureOk = true, drainWorks = true,
  protectCalls = {}, castHandles = {}, leashes = 0, follows = 0, bolts = 0, calms = 0, replaced = 0, noInfo = false}
local function fresh(t)
  local gen = game.tick
  return setmetatable({}, {__index = function(_, k)
    if gen ~= game.tick then game.stale = true; error('a stale handle was used: ' .. tostring(k)) end
    return t[k]
  end})
end
local function actorOf(handle) return type(handle) == 'table' and game.actors[handle.id] or nil end
local function spawnActor(request)
  game.spawnRequests[#game.spawnRequests + 1] = request
  if game.spawnFail > 0 then game.spawnFail = game.spawnFail - 1; return nil, 'The game could not create the character.' end
  local id = 'a' .. game.nextActor; game.nextActor = game.nextActor + 1
  game.actors[id] = {id = id, attached = false, dead = false, defeated = false, health = 100, combat = false, mounted = false, x = request.x, y = request.y, z = request.z,
    request = request, deleted = false}
  return {kind = 'extra', id = id}
end
local raw = {
  playerPosition = function() return fresh(game.vpos) end,
  hiddenFromPlayer = function() return game.hidden end,
  rayDown = function() return nil end,
  squadVerify = function(record, group) return not game.verifyFail[record] end,
  squadSpawn = spawnActor,
  actorSpawn = spawnActor,
  actorDelete = function(handle) local a = actorOf(handle); if a then a.deleted = true end; game.deleted[#game.deleted + 1] = handle.id end,
  actorState = function(handle)
    local a = actorOf(handle)
    if not a or a.deleted or not a.attached then return nil end
    return fresh({dead = a.dead, defeated = a.defeated, health = a.health, combat = a.combat, mounted = a.mounted, x = a.x, y = a.y, z = a.z})
  end,
  actorInfo = function(handle) if game.noInfo then return nil end; return {record = 'Character.victim', appearance = 'torn_jacket'} end,
  actorReplace = function(handle, request)
    game.replaced = game.replaced + 1
    return spawnActor(request)
  end,
  squadArm = function(handle, options)
    local a = actorOf(handle)
    game.order[#game.order + 1] = 'arm:' .. handle.id .. (options and options.shared and ':shared' or '')
    if game.armCombat and a then a.combat = true end
    return game.armOk, game.armOk and '' or 'combat'
  end,
  hostageConfigure = function(handle) game.order[#game.order + 1] = 'configure@' .. game.now; return game.configureOk, 'attitude' end,
  hostageDrain = function(handle)
    game.order[#game.order + 1] = 'drain@' .. game.now
    local a = actorOf(handle)
    if a and game.drainWorks then a.health = 10 end
    return true
  end,
  hostageProtect = function(handle, on) game.protectCalls[#game.protectCalls + 1] = on; return true end,
  hostageRaise = function(handle) local a = actorOf(handle); if a then a.health = 100 end; game.order[#game.order + 1] = 'raise'; return true end,
  escorteeConfigure = function(handle, options) game.order[#game.order + 1] = 'escort-configure:' .. tostring(options and options.bonus); return true end,
  escorteeFollow = function() game.follows = game.follows + 1; return true end,
  escorteeBolt = function() game.bolts = game.bolts + 1; return true end,
  escorteeCalm = function() game.calms = game.calms + 1; return true end,
  escorteeLeash = function() game.leashes = game.leashes + 1; return true end,
  castSpawn = function(request)
    if game.castCopy then return {kind = 'copy', appointment = 'quest:' .. request.id} end
    local h = spawnActor(request); if h then game.castHandles[request.id] = h end; return h
  end,
  castLookup = function(handle) return nil end,
  castDelete = function(handle) local a = actorOf(handle); if a then a.deleted = true end; game.deleted[#game.deleted + 1] = handle.id end,
  pinAdd = function() return nil end, pinRemove = function() end,
}
-- Every world function counts its calls.
local world = {}
for name, fn in pairs(raw) do
  world[name] = function(...) game.calls[name] = (game.calls[name] or 0) + 1; return fn(...) end
end
local function totalCalls() local n = 0 for _, v in pairs(game.calls) do n = n + v end return n end
local places = Places.new({world = world, clock = function() return game.now end, log = log})
local prims = Prims.new({places = places, world = world, clock = function() return game.now end, gameTime = function() return game.gameClock end, log = log})
prims.env.ambush = Ambush
prims.env.actionNatives = {}
assert(prims.extend(Action))
local sunset = {x = 100, y = 200, z = 10, radius = 25}
local function stageCtx(pack)
  local ctx = newCtx(pack or 'pk', 'panam-palmer')
  ctx.places = {sunset = sunset, far = {x = 5000, y = 0, z = 0, radius = 20}, dock = {x = 400, y = 200, z = 10, radius = 20}}
  function ctx:after(seconds, fn, opts)
    local real = opts and opts.real == true
    self.timers[#self.timers + 1] = {at = (real and game.now or game.gameClock) + seconds, real = real, fn = fn}
  end
  return ctx
end
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
    for index = #ctx.timers, 1, -1 do
      local t = ctx.timers[index]
      if t and (t.real and game.now or game.gameClock) >= t.at then table.remove(ctx.timers, index); t.fn() end
    end
    for _, inst in ipairs(insts) do
      if inst.def.tick and game.now >= inst.nextAt then
        inst.nextAt = game.now + (inst.def.interval or 1)
        inst.def.tick(ctx, inst.spec, inst.state, prims.env)
      end
    end
  end
end
local function attachAll() for _, a in pairs(game.actors) do a.attached = true end end
local function count(t) local n = 0 for _ in pairs(t) do n = n + 1 end return n end
local function actorList()
  local list = {}
  for _, a in pairs(game.actors) do list[#list + 1] = a end
  table.sort(list, function(a, b) return tonumber(a.id:sub(2)) < tonumber(b.id:sub(2)) end)
  return list
end
local function near() game.vpos = {x = 100, y = 200 - 100, z = 10} end   -- 100 m from the place
`;
const withGame = code => run(`${harness}\n${code}\nassert(not game.stale, 'a handle was kept across ticks')`);

// ---- squad -------------------------------------------------------------------------------------------------------------------------------------------

test('squad: nothing before V is within 150 m, nothing before the spot is out of sight, one step a second only reads V until then', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'squad', id = 'den', at = 'sunset', faction = 'maelstrom', count = 3}})
assert(#insts == 1)
game.vpos = {x = 100, y = 200 + 200, z = 10}
advance(ctx, insts, 10); assert(#game.spawnRequests == 0 and (game.calls.hiddenFromPlayer or 0) == 0, 'V is 200 m away: no spawn and no sight query')
game.vpos = {x = 100, y = 200 + 120, z = 10}; game.hidden = false
advance(ctx, insts, 10); assert(#game.spawnRequests == 0, 'in view: it waits')
game.hidden = true
advance(ctx, insts, 1); assert(#game.spawnRequests == 3, #game.spawnRequests)
`));

test('squad: when the sight cannot be told it spawns only 60 m or more away, and a spot V keeps staring at is made after 20 s (25 m or more) and 40 s at last', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'squad', id = 'den', at = 'sunset', faction = 'maelstrom', count = 1}})
game.hidden = nil
game.vpos = {x = 100, y = 200 - 40, z = 10}
advance(ctx, insts, 15); assert(#game.spawnRequests == 0, '40 m and unknown sight')
game.vpos = {x = 100, y = 200 - 90, z = 10}
advance(ctx, insts, 1); assert(#game.spawnRequests == 1, 'unknown sight but 90 m')
local c2 = stageCtx('p2')
local more = drive(c2, {{p = 'squad', id = 'den', at = 'sunset', faction = 'maelstrom', count = 1}})
game.hidden = false; game.vpos = {x = 100, y = 200 - 40, z = 10}
advance(c2, more, 19); assert(#game.spawnRequests == 1)
advance(c2, more, 3); assert(#game.spawnRequests == 2, 'after 20 s in range, 40 m away')
local c3 = stageCtx('p3')
local third = drive(c3, {{p = 'squad', id = 'den', at = 'sunset', faction = 'maelstrom', count = 1}})
game.vpos = {x = 100, y = 200 - 5, z = 10}
advance(c3, third, 30); assert(#game.spawnRequests == 2, 'close and looking: still waiting')
advance(c3, third, 12); assert(#game.spawnRequests == 3, 'at last after 40 s')
`));

test('squad: far away it only looks every 5 s', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'squad', id = 'den', at = 'sunset', faction = 'maelstrom', count = 1}})
game.vpos = {x = 100, y = 200 + 500, z = 10}
advance(ctx, insts, 60)
assert(game.calls.playerPosition <= 13, game.calls.playerPosition)
`));

test('squad: every spawn is tagged and named, spawned only after attach, members get the faction records, bad squads are not armed', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'squad', id = 'den', at = 'sunset', faction = 'maelstrom', count = 3}, {p = 'squad', at = 'sunset', faction = 'maelstrom'},
  {p = 'squad', id = 'x', at = 'nowhere', faction = 'maelstrom'}, {p = 'squad', id = 'y', at = 'sunset', faction = 'nonsense'}})
assert(#insts == 1)
near(); advance(ctx, insts, 2)
assert(#game.spawnRequests == 3)
for i, r in ipairs(game.spawnRequests) do
  assert(r.tag == 'CyberpunkConvaiQuest:pk' and r.id == 'pk:den:' .. i and r.who == 'extra' and r.faction == 'maelstrom', r.id)
  assert(r.record:find('^Character%.') and r.x and r.y and r.z)
end
assert(#ctx.tracked == 3 and ctx.tracked[1].kind == 'squad')
advance(ctx, insts, 4); assert(ctx:count('squad:den:spawned') == 0, 'the game has not attached them: nothing is used or announced')
assert((game.calls.squadArm or 0) == 0)
attachAll(); advance(ctx, insts, 1); assert(ctx:count('squad:den:spawned') == 1)
advance(ctx, insts, 5); assert(ctx:count('squad:den:spawned') == 1, 'once')
assert(logged('squad has no id') and logged('place nowhere is not in the stage') and logged('unknown faction'))
`));

test('squad: the faction may be the game affiliation name, kinds pick records by word or by name, a record the game lacks is skipped, none left means no squad', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'squad', id = 'a', at = 'sunset', faction = 'TygerClaws', count = 2, kinds = {'katana'}}})
near(); advance(ctx, insts, 2)
assert(#game.spawnRequests == 2 and game.spawnRequests[1].record == 'Character.tyger_claws_gang3_katana_wa' and game.spawnRequests[2].record == 'Character.tyger_claws_gang3_katana_wa', game.spawnRequests[1].record)
local c2 = stageCtx('p2')
game.spawnRequests = {}
local more = drive(c2, {{p = 'squad', id = 'b', at = 'sunset', faction = 'maelstrom', count = 2, kinds = {'Character.maelstrom_grunt1_ranged1_lexington_ma', 'Character.does_not_exist'}}})
game.verifyFail['Character.does_not_exist'] = true
advance(c2, more, 2)
assert(#game.spawnRequests == 2 and game.spawnRequests[1].record == 'Character.maelstrom_grunt1_ranged1_lexington_ma' and game.spawnRequests[2].record == game.spawnRequests[1].record)
local c3 = stageCtx('p3')
game.spawnRequests = {}
for _, r in ipairs(Ambush.SEEDS.valentinos) do game.verifyFail[r] = true end
local third = drive(c3, {{p = 'squad', id = 'c', at = 'sunset', faction = 'valentinos', count = 2}})
advance(c3, third, 3)
assert(#game.spawnRequests == 0 and logged('no fighter record found for valentinos') and #c3.events == 0)
`));

test('squad: relaxed is the default, nothing is made hostile, a member in combat turns the whole squad hostile once, :go does the same', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'squad', id = 'den', at = 'sunset', faction = 'maelstrom', count = 3}})
near(); advance(ctx, insts, 2); attachAll(); advance(ctx, insts, 10)
assert(ctx:count('squad:den:spawned') == 1 and (game.calls.squadArm or 0) == 0 and ctx:count('squad:den:hostile') == 0, 'relaxed: not touched')
game.armCombat = false
actorList()[2].combat = true
advance(ctx, insts, 1)
assert(ctx:count('squad:den:hostile') == 1)
local armed = game.calls.squadArm
assert(armed == 2, 'the other two are made hostile, the one in combat is left: ' .. tostring(armed))
advance(ctx, insts, 3); assert(ctx:count('squad:den:hostile') == 1 and game.calls.squadArm == 2 + 3 * 2, 'asked again every second for those not in combat')
-- :go
local c2 = stageCtx('p2')
local more = drive(c2, {{p = 'squad', id = 'g', at = 'sunset', faction = 'maelstrom', count = 2}})
advance(c2, more, 2); attachAll(); advance(c2, more, 2)
local before = game.calls.squadArm
c2:emit('squad:g:go'); assert(c2:count('squad:g:hostile') == 1)
advance(c2, more, 1); assert(game.calls.squadArm > before)
c2:emit('squad:g:go'); assert(c2:count('squad:g:hostile') == 1, 'once')
`));

test('squad: hostile squads arm each member as soon as it is attached, spawned comes first then hostile, shared is passed, the recipe is asked again while not in combat', () => withGame(`
local ctx = stageCtx()
game.armCombat = false
local insts = drive(ctx, {{p = 'squad', id = 'den', at = 'sunset', faction = 'maelstrom', count = 2, hostile = true, shared = true}})
near(); advance(ctx, insts, 2)
assert((game.calls.squadArm or 0) == 0, 'not before they are attached')
attachAll(); advance(ctx, insts, 1)
assert(ctx.events[1] == 'squad:den:spawned' and ctx.events[2] == 'squad:den:hostile', table.concat(ctx.events, ','))
assert(game.calls.squadArm == 2 and game.order[1]:find(':shared'))
advance(ctx, insts, 2); assert(game.calls.squadArm == 6, 'about once a second')
game.order = {}; game.armOk = false
advance(ctx, insts, 1); assert(logged('could not be made hostile: combat'))
`));

test('squad: down counts dead, defeated and a health pool at zero only after the member was seen alive, a vanished one after two reads, :down once for all', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'squad', id = 'den', at = 'sunset', faction = 'maelstrom', count = 4}})
near(); advance(ctx, insts, 2)
local list = actorList()
list[1].attached = true; list[1].health = 0         -- reads zero on its first sight: never seen alive
list[2].attached = true; list[3].attached = true; list[4].attached = true
advance(ctx, insts, 3); assert(ctx:count('squad:den:down') == 0 and ctx:count('squad:den:spawned') == 0)
list[1].health = 100; advance(ctx, insts, 2); assert(ctx:count('squad:den:spawned') == 1)
list[1].dead = true; advance(ctx, insts, 1); assert(ctx:count('squad:den:down') == 0)
list[2].defeated = true; list[3].health = 0; advance(ctx, insts, 2); assert(ctx:count('squad:den:down') == 0)
list[4].attached = false; advance(ctx, insts, 1); assert(ctx:count('squad:den:down') == 0, 'one miss is not enough')
advance(ctx, insts, 1); assert(ctx:count('squad:den:down') == 1, 'seen, then gone for two reads: down')
advance(ctx, insts, 10); assert(ctx:count('squad:den:down') == 1 and ctx:count('squad:den:fled') == 0)
local reads = game.calls.actorState
advance(ctx, insts, 5); assert(game.calls.actorState == reads, 'finished: nothing is read any more')
`));

test('squad: a member that never attaches is made again, then given up, and the others still decide spawned and down', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'squad', id = 'den', at = 'sunset', faction = 'maelstrom', count = 2}})
near(); advance(ctx, insts, 2)
local list = actorList(); list[1].attached = true
advance(ctx, insts, 14); assert(#game.spawnRequests == 3 and list[2].deleted, 'the second never attached: deleted and made again')
advance(ctx, insts, 40)
assert(#game.spawnRequests == 4, #game.spawnRequests)
assert(logged('never attached, given up') and ctx:count('squad:den:spawned') == 1)
list[1].dead = true; advance(ctx, insts, 2); assert(ctx:count('squad:den:down') == 1)
`));

test('squad: a failed spawn is tried again up to five times three seconds apart and then given up with a log', () => withGame(`
local ctx = stageCtx()
game.spawnFail = 100
local insts = drive(ctx, {{p = 'squad', id = 'den', at = 'sunset', faction = 'maelstrom', count = 1}})
near(); advance(ctx, insts, 40)
assert(#game.spawnRequests == 5 and logged('spawn try 5 failed') and #ctx.tracked == 0 and #ctx.events == 0)
`));

test('squad: waves by timer and by whenDown, wave<N> after attach, :down only after the last wave, waves are hostile when the squad is', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'squad', id = 'den', at = 'sunset', faction = 'maelstrom', count = 2, hostile = true,
  waves = {{afterSeconds = 30, count = 2}, {whenDown = true, count = 1}}}})
near(); advance(ctx, insts, 2); attachAll(); advance(ctx, insts, 2)
assert(#game.spawnRequests == 2 and ctx:count('squad:den:spawned') == 1)
advance(ctx, insts, 20); assert(#game.spawnRequests == 2, 'the timer has not run out')
advance(ctx, insts, 12); assert(#game.spawnRequests == 4, 'wave 1 by timer')
assert(ctx:count('squad:den:wave1') == 0, 'not announced before it is attached')
attachAll(); advance(ctx, insts, 1); assert(ctx:count('squad:den:wave1') == 1)
local list = actorList()
list[1].dead = true; list[2].dead = true; advance(ctx, insts, 2)
assert(#game.spawnRequests == 4 and ctx:count('squad:den:down') == 0, 'wave 1 still stands')
list[3].dead = true; list[4].dead = true; advance(ctx, insts, 2)
assert(#game.spawnRequests == 5, 'wave 2: when every member so far is down')
assert(ctx:count('squad:den:down') == 0)
local armedBefore = game.calls.squadArm
attachAll(); advance(ctx, insts, 2); assert(ctx:count('squad:den:wave2') == 1)
assert(game.calls.squadArm > armedBefore, 'the wave is hostile')
list = actorList(); list[5].dead = true; advance(ctx, insts, 2)
assert(ctx:count('squad:den:down') == 1)
local order = table.concat(ctx.events, ',')
assert(order:find('spawned,squad:den:hostile.*wave1.*wave2.*down'), order)
`));

test('squad: a wave that is whenDown does not fire while an earlier timed wave is still to come', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'squad', id = 'den', at = 'sunset', faction = 'maelstrom', count = 2,
  waves = {{afterSeconds = 50, count = 2}, {whenDown = true, count = 2}}}})
near(); advance(ctx, insts, 2); attachAll(); advance(ctx, insts, 2)
for _, a in ipairs(actorList()) do a.dead = true end
advance(ctx, insts, 30); assert(#game.spawnRequests == 2 and ctx:count('squad:den:down') == 0, 'the timed wave is still to come')
advance(ctx, insts, 25); assert(#game.spawnRequests == 4, 'wave 1 by timer')
attachAll(); advance(ctx, insts, 2); assert(#game.spawnRequests == 4)
for _, a in ipairs(actorList()) do a.dead = true end
advance(ctx, insts, 2); assert(#game.spawnRequests == 6, 'wave 2 once all are down')
`));

test('squad: a squad never grows past 24 members whatever its waves say', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'squad', id = 'den', at = 'sunset', faction = 'maelstrom', count = 8,
  waves = {{afterSeconds = 1, count = 8}, {afterSeconds = 1, count = 8}, {afterSeconds = 1, count = 8}, {afterSeconds = 1, count = 8}}}})
near(); advance(ctx, insts, 2); attachAll(); advance(ctx, insts, 10)
assert(#game.spawnRequests == 24, #game.spawnRequests)
`));

test('squad: the timed alert turns a relaxed squad hostile after the seconds, once', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'squad', id = 'den', at = 'sunset', faction = 'maelstrom', count = 2, alertAfterSeconds = 20}})
near(); advance(ctx, insts, 2); attachAll(); advance(ctx, insts, 10)
assert(ctx:count('squad:den:hostile') == 0 and (game.calls.squadArm or 0) == 0)
advance(ctx, insts, 15); assert(ctx:count('squad:den:hostile') == 1)
advance(ctx, insts, 2); assert(game.calls.squadArm >= 2 and ctx:count('squad:den:hostile') == 1)
`));

test('squad: fled when V is 200 m away for 60 s, everything deleted, not when V comes back in time or a member is near V, no down after', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'squad', id = 'den', at = 'sunset', faction = 'maelstrom', count = 3}})
near(); advance(ctx, insts, 2); attachAll(); advance(ctx, insts, 2)
game.vpos = {x = 100, y = 200 + 260, z = 10}
advance(ctx, insts, 50); assert(ctx:count('squad:den:fled') == 0)
game.vpos = {x = 100, y = 200 + 100, z = 10}
advance(ctx, insts, 5)
game.vpos = {x = 100, y = 200 + 260, z = 10}
advance(ctx, insts, 55); assert(ctx:count('squad:den:fled') == 0, 'the minute starts again')
advance(ctx, insts, 8)
assert(ctx:count('squad:den:fled') == 1 and #game.deleted == 3, #game.deleted)
for _, a in ipairs(actorList()) do assert(a.deleted) end
advance(ctx, insts, 20); assert(ctx:count('squad:den:fled') == 1 and ctx:count('squad:den:down') == 0 and #game.deleted == 3)
ctx:reap(); assert(#game.deleted == 3, 'the ctx deletes nothing twice')
-- Hostile members that chase V keep the squad alive even when V is far from the place.
local c2 = stageCtx('p2')
local more = drive(c2, {{p = 'squad', id = 'chase', at = 'sunset', faction = 'maelstrom', count = 1}})
game.vpos = {x = 100, y = 200 - 100, z = 10}
advance(c2, more, 2); attachAll(); advance(c2, more, 2)
local mover = actorList()[#actorList()]
game.vpos = {x = 100, y = 200 + 260, z = 10}
mover.x, mover.y = 100, 200 + 255
advance(c2, more, 100); assert(c2:count('squad:chase:fled') == 0, 'a member is near V')
`));

test('squad: reap deletes everything it made, once, including members still not attached', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'squad', id = 'den', at = 'sunset', faction = 'maelstrom', count = 4, waves = {{afterSeconds = 5, count = 2}}}})
near(); advance(ctx, insts, 2); attachAll(); advance(ctx, insts, 8)
assert(#game.spawnRequests == 6)
ctx:reap()
assert(#game.deleted == 6, #game.deleted)
local seen = {}
for _, id in ipairs(game.deleted) do assert(not seen[id], 'deleted twice: ' .. id); seen[id] = true end
`));

test('squad: the cost of eight members over a simulated minute is bounded', () => withGame(`
game.armCombat = false
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'squad', id = 'den', at = 'sunset', faction = 'maelstrom', count = 8, hostile = true}})
near(); advance(ctx, insts, 2); attachAll(); advance(ctx, insts, 2)
for k in pairs(game.calls) do game.calls[k] = 0 end
advance(ctx, insts, 60)
assert(game.calls.actorState == 8 * 60, 'one state read per member per second: ' .. game.calls.actorState)
assert(game.calls.playerPosition == 60 and game.calls.squadArm == 8 * 60)
assert((game.calls.squadSpawn or 0) == 0 and (game.calls.hiddenFromPlayer or 0) == 0)
assert(totalCalls() <= 17 * 60, totalCalls())
-- in combat they are left alone: reads only
game.armCombat = true
for _, a in ipairs(actorList()) do a.combat = true end
for k in pairs(game.calls) do game.calls[k] = 0 end
advance(ctx, insts, 60)
assert(totalCalls() <= 9 * 60 and (game.calls.squadArm or 0) == 0, totalCalls())
`));

// ---- hostage -----------------------------------------------------------------------------------------------------------------------------------------

const hostageSpec = `{p = 'hostage', id = 'boy', at = 'sunset', kind = 'floor', record = 'Character.victim'}`;

test('hostage: spawned friendly and tagged when V is near, configured when attached, drained half a second later, checked, then down once', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {${hostageSpec}, {p = 'hostage', id = 'x', at = 'sunset', kind = 'workspot', record = 'Character.victim'}, {p = 'hostage', id = 'y', at = 'sunset'}})
assert(#insts == 1 and logged('is not built') and logged('needs a cast id or a record'))
game.vpos = {x = 100, y = 200 + 300, z = 10}; advance(ctx, insts, 5); assert(#game.spawnRequests == 0)
near(); advance(ctx, insts, 2)
local r = game.spawnRequests[1]
assert(#game.spawnRequests == 1 and r.record == 'Character.victim' and r.friendly == true and r.tag == 'CyberpunkConvaiQuest:pk' and r.id == 'pk:hostage:boy', 'spawned')
assert(#ctx.tracked == 1 and ctx.tracked[1].kind == 'hostage')
advance(ctx, insts, 5); assert((game.calls.hostageConfigure or 0) == 0 and ctx:count('hostage:boy:down') == 0, 'not before attach')
attachAll(); advance(ctx, insts, 1)
local configured = game.now
assert(game.order[1] == 'configure@' .. configured)
advance(ctx, insts, 1)
assert(game.order[2] == 'drain@' .. game.now and game.now - configured >= 0.5, 'drained after the configuration: ' .. table.concat(game.order, ','))
assert(ctx:count('hostage:boy:down') == 0)
advance(ctx, insts, 1); assert(ctx:count('hostage:boy:down') == 1, 'verified')
advance(ctx, insts, 20); assert(ctx:count('hostage:boy:down') == 1 and ctx:count('hostage:boy:freed') == 0)
`));

test('hostage: a drain that does not hold is asked again up to three times, a pool that cannot be read counts when the drain was accepted', () => withGame(`
game.drainWorks = false
local ctx = stageCtx()
local insts = drive(ctx, {${hostageSpec}})
near(); advance(ctx, insts, 2); attachAll(); advance(ctx, insts, 20)
assert(game.calls.hostageDrain == 3 and ctx:count('hostage:boy:down') == 0 and logged('could not be put down'))
local c2 = stageCtx('p2')
local more = drive(c2, {${hostageSpec}})
world.actorState = function(handle)
  local a = actorOf(handle)
  if not a or not a.attached then return nil end
  return fresh({dead = false, defeated = false, health = nil, combat = false, x = a.x, y = a.y, z = a.z})
end
advance(c2, more, 2); attachAll(); advance(c2, more, 6); assert(c2:count('hostage:boy:down') == 1)
`));

test('hostage: V within 3 m for the hold frees her once (protection off, pool refilled), a step away resets the hold, the stage event frees her at once', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {${hostageSpec}})
near(); advance(ctx, insts, 2); attachAll(); advance(ctx, insts, 5); assert(ctx:count('hostage:boy:down') == 1)
game.vpos = {x = 100 + 2, y = 200, z = 10}
advance(ctx, insts, 3)
game.vpos = {x = 100 + 20, y = 200, z = 10}
advance(ctx, insts, 3)
game.vpos = {x = 100 + 2, y = 200, z = 10}
advance(ctx, insts, 4); assert(ctx:count('hostage:boy:freed') == 0, 'the hold started again')
advance(ctx, insts, 3); assert(ctx:count('hostage:boy:freed') == 1)
assert(game.protectCalls[#game.protectCalls] == false and game.order[#game.order] == 'raise')
advance(ctx, insts, 10); assert(ctx:count('hostage:boy:freed') == 1 and ctx:count('hostage:boy:dead') == 0)
-- an interaction
local c2 = stageCtx('p2')
local more = drive(c2, {{p = 'hostage', id = 'by-event', at = 'sunset', record = 'Character.victim', on = 'interact:boy'}})
game.vpos = {x = 100, y = 200 - 80, z = 10}
advance(c2, more, 2); attachAll(); advance(c2, more, 5); assert(c2:count('hostage:by-event:down') == 1)
c2:emit('interact:boy'); advance(c2, more, 1); assert(c2:count('hostage:by-event:freed') == 1)
`));

test('hostage: the exposed event lifts her protection (also when it comes before she is configured), and she dies for good once exposed and killed', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {${hostageSpec}})
near(); advance(ctx, insts, 2); attachAll(); advance(ctx, insts, 5)
assert(#game.protectCalls == 0)
ctx:emit('hostage:boy:exposed'); assert(game.protectCalls[#game.protectCalls] == false)
actorList()[1].dead = true; advance(ctx, insts, 1)
assert(ctx:count('hostage:boy:dead') == 1)
advance(ctx, insts, 5); assert(ctx:count('hostage:boy:dead') == 1 and ctx:count('hostage:boy:freed') == 0)
local c2 = stageCtx('p2')
game.protectCalls = {}
local more = drive(c2, {{p = 'hostage', id = 'early', at = 'sunset', record = 'Character.victim'}})
c2:emit('hostage:early:exposed')
advance(c2, more, 3); attachAll(); advance(c2, more, 2)
assert(game.protectCalls[1] == false, 'lifted as soon as she was configured')
`));

test('hostage: a vanished hostage is dead, a cast extra is used as she is (not spawned again, not deleted twice)', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {${hostageSpec}})
near(); advance(ctx, insts, 2); attachAll(); advance(ctx, insts, 5)
actorList()[1].attached = false
advance(ctx, insts, 1); assert(ctx:count('hostage:boy:dead') == 0)
advance(ctx, insts, 1); assert(ctx:count('hostage:boy:dead') == 1)
-- cast
game.deleted = {}; game.calls.hostageConfigure = 0
local c2 = stageCtx('p2')
local more = drive(c2, {{p = 'cast', id = 'tom', who = 'extra', at = 'sunset', record = 'Character.victim'}, {p = 'hostage', id = 'tom-h', at = 'sunset', cast = 'tom'}})
assert(#more == 2)
game.spawnRequests = {}
advance(c2, more, 2)
assert(#game.spawnRequests == 1 and game.spawnRequests[1].id == 'p2:tom', 'only the cast spawned')
attachAll(); advance(c2, more, 3)
assert(game.calls.hostageConfigure == 1 and #game.spawnRequests == 1, 'the cast extra was configured as she is')
advance(c2, more, 3); assert(c2:count('hostage:tom-h:down') == 1)
c2:reap(); assert(#game.deleted == 1 and game.deleted[1] == game.castHandles['p2:tom'].id, 'the cast owns the body: deleted once')
`));

// ---- escortee ----------------------------------------------------------------------------------------------------------------------------------------

test('escortee: taken over from a freed hostage, configured with the bonus, follows, and the leash needs 25 m, no mount and no sight', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {${hostageSpec}, {p = 'escortee', id = 'boy-e', from = 'boy'}})
assert(#insts == 2)
near(); advance(ctx, insts, 2); attachAll(); advance(ctx, insts, 5)
assert((game.calls.escorteeConfigure or 0) == 0, 'she is not freed yet')
game.vpos = {x = 100 + 2, y = 200, z = 10}; advance(ctx, insts, 7)
assert(ctx:count('hostage:boy:freed') == 1)
advance(ctx, insts, 2)
assert(game.calls.escorteeConfigure == 1 and game.order[#game.order]:find('escort%-configure:1.5'), table.concat(game.order, ','))
assert(#ctx.tracked == 1, 'one body, one owner')
-- leash
local body = actorList()[1]
game.hidden = false
game.vpos = {x = 100 + 60, y = 200, z = 10}
advance(ctx, insts, 12); assert(game.leashes == 0, 'in sight')
assert(game.follows >= 1, 'asked to follow again while she is far')
game.hidden = true; body.mounted = true
advance(ctx, insts, 12); assert(game.leashes == 0, 'mounted')
body.mounted = false
game.vpos = {x = 100 + 10, y = 200, z = 10}
advance(ctx, insts, 12); assert(game.leashes == 0, 'closer than 25 m')
game.vpos = {x = 100 + 60, y = 200, z = 10}
advance(ctx, insts, 1); assert(game.leashes == 1)
advance(ctx, insts, 3); assert(game.leashes == 1, 'not every second')
advance(ctx, insts, 4); assert(game.leashes == 2)
`));

test('escortee: bolts on the tag and is talked back, both once, nothing while not bolted, the leash and follow stop while she bolts', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'cast', id = 'witness', who = 'extra', at = 'sunset', record = 'Character.victim'}, {p = 'escortee', id = 'w', from = 'witness', boltOn = 'gap:g1:scared'}})
near(); advance(ctx, insts, 2); attachAll(); advance(ctx, insts, 4)
assert(game.calls.escorteeConfigure == 1)
ctx:emit('escortee:w:calm'); assert(ctx:count('escortee:w:back') == 0, 'not bolted')
ctx:emit('escortee:w:bolt'); assert(ctx:count('escortee:w:bolted') == 1 and game.bolts == 1)
ctx:emit('gap:g1:scared'); assert(ctx:count('escortee:w:bolted') == 1, 'once')
game.vpos = {x = 100 + 80, y = 200, z = 10}; game.hidden = true
advance(ctx, insts, 20); assert(game.leashes == 0 and game.follows == 0, 'no leash while she bolts')
ctx:emit('escortee:w:calm'); assert(ctx:count('escortee:w:back') == 1 and game.calms == 1)
advance(ctx, insts, 2); assert(game.leashes == 1, 'following again')
`));

test('escortee: lost when dead or defeated or vanished, once; arrived once inside the place; a copy of a character is not taken', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'cast', id = 'witness', who = 'extra', at = 'sunset', record = 'Character.victim'}, {p = 'escortee', id = 'w', from = 'witness', to = 'dock'}})
near(); advance(ctx, insts, 2); attachAll(); advance(ctx, insts, 4)
local body = actorList()[1]
body.x, body.y = 400, 200
advance(ctx, insts, 2); assert(ctx:count('escortee:w:arrived') == 1)
advance(ctx, insts, 5); assert(ctx:count('escortee:w:arrived') == 1)
body.defeated = true; advance(ctx, insts, 1)
assert(ctx:count('escortee:w:lost') == 1)
advance(ctx, insts, 5); assert(ctx:count('escortee:w:lost') == 1)
local c2 = stageCtx('p2')
local more = drive(c2, {{p = 'cast', id = 'witness', who = 'extra', at = 'sunset', record = 'Character.victim'}, {p = 'escortee', id = 'v', from = 'witness'}})
advance(c2, more, 2); attachAll(); advance(c2, more, 3)
local b2 = actorList()[#actorList()]
b2.attached = false
advance(c2, more, 1); assert(c2:count('escortee:v:lost') == 0)
advance(c2, more, 1); assert(c2:count('escortee:v:lost') == 1)
local c3 = stageCtx('p3')
game.castCopy = true
local third = drive(c3, {{p = 'cast', id = 'judy', who = 'judy-alvarez', at = 'sunset'}, {p = 'escortee', id = 'j', from = 'judy'}})
advance(c3, third, 4); assert(logged('escorted by the party') and #c3.tracked == 1)
local nobody = drive(stageCtx('p4'), {{p = 'escortee', id = 'n'}})
assert(#nobody == 0 and logged('has nothing to follow from'))
`));

test('escortee: in the next stage a fresh copy with the same appearance is made out of V sight beside V and moved to V side at once, the old stage owner deleted the old body', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {${hostageSpec}, {p = 'escortee', id = 'boy-e', from = 'boy'}})
near(); advance(ctx, insts, 2); attachAll(); advance(ctx, insts, 5)
game.vpos = {x = 100 + 2, y = 200, z = 10}; advance(ctx, insts, 10)
assert(ctx:count('hostage:boy:freed') == 1 and game.calls.escorteeConfigure == 1)
ctx:reap(); assert(#game.deleted == 1, 'the stage ends: the body goes')
-- next stage
local next = stageCtx('pk')
game.spawnRequests = {}
local more = drive(next, {{p = 'escortee', id = 'boy-e'}})
assert(#more == 1, 'armed from what the last stage remembered')
game.hidden = false
advance(next, more, 3); assert(#game.spawnRequests == 0, 'not in view')
game.hidden = true
advance(next, more, 2)
local r = game.spawnRequests[1]
assert(#game.spawnRequests == 1 and r.record == 'Character.victim' and r.appearance == 'torn_jacket' and r.tag == 'CyberpunkConvaiQuest:pk' and r.friendly == true)
assert(math.abs(math.sqrt((r.x - 102) ^ 2 + (r.y - 200) ^ 2) - 12) < 0.01, 'on the ring around V')
local before = game.leashes
attachAll(); advance(next, more, 3)
assert(game.leashes == before + 1 and #next.tracked == 1, 'moved to V side')
-- another pack has no memory of it
assert(#drive(stageCtx('other'), {{p = 'escortee', id = 'boy-e'}}) == 0)
-- the fallback record
assert(#drive(stageCtx('other'), {{p = 'escortee', id = 'boy-e', record = 'Character.victim'}}) == 1)
`));

test('escortee: the swap event replaces her with a fresh copy of the same appearance, the old body goes only once the new one is in', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'cast', id = 'witness', who = 'extra', at = 'sunset', record = 'Character.victim'}, {p = 'escortee', id = 'w', from = 'witness'}})
near(); advance(ctx, insts, 2); attachAll(); advance(ctx, insts, 4)
local old = actorList()[1]
ctx:emit('escortee:w:swap'); assert(game.replaced == 1)
assert(not old.deleted, 'not yet')
advance(ctx, insts, 2); assert(not old.deleted, 'the new one is not attached')
attachAll(); advance(ctx, insts, 3)
assert(old.deleted and game.calls.escorteeConfigure == 2 and #ctx.tracked == 2)
local reads = game.calls.actorState
advance(ctx, insts, 2); assert(game.calls.actorState == reads + 2, 'one read a second, the new body')
local swapped = game.deleted
ctx:reap()
local tally = {}
for _, id in ipairs(game.deleted) do tally[id] = (tally[id] or 0) + 1 end
assert(tally.a2 == 1 and tally.a1 >= 1, 'the fresh body is deleted once by its owner')
`));

test('escortee and hostage: a world with no functions at all survives every primitive', () => withGame(`
local empty = Prims.new({places = Places.new({world = {}, clock = function() return game.now end}), world = {}, clock = function() return game.now end})
empty.env.ambush = Ambush
empty.env.actionNatives = {}
assert(empty.extend(Action))
local c = stageCtx('e')
for _, spec in ipairs({{p = 'squad', id = 's', at = 'sunset', faction = 'maelstrom'}, {p = 'hostage', id = 'h', at = 'sunset', record = 'Character.victim'},
  {p = 'escortee', id = 'e', from = 'h', record = 'Character.victim'}}) do
  local def = empty.get(spec.p)
  local state = def.arm(c, spec, empty.env)
  assert(state ~= nil)
  def.tick(c, spec, state, empty.env); def.tick(c, spec, state, empty.env)
  if def.disarm then def.disarm(c, spec, state, empty.env) end
end
assert(#c.events == 0)
`));

// ---- with the real quest module behind it ------------------------------------------------------------------------------------------------------------

test('with the real quest module: a stage arms squad, hostage and escortee, their events reach the events file and the rows, a new stage reaps every spawn once', () => withGame(`
local Play = ${load('quest-play.lua')}
local files = {}
local play = Play.new({enabled = function() return true end, clock = function() return game.now end, gameTime = function() return game.gameClock end,
  read = function(path) return files[path] end, write = function(path, text) files[path] = text; return true end, encode = serialize, decode = decode,
  places = places, prims = prims, session = 's', log = log})
local function step(seconds)
  for _ = 1, math.floor(seconds * 10 + 0.5) do
    game.now = game.now + 0.1; game.gameClock = game.gameClock + 0.1; game.tick = game.tick + 1
    play.update('V', 0.1)
  end
end
local function names()
  local list = {}
  for _, e in ipairs(files[Play.EVENTS] and decode(files[Play.EVENTS]).events or {}) do list[#list + 1] = e.name end
  return table.concat(list, ' ')
end
local doList = {{p = 'squad', id = 'den', at = 'sunset', faction = 'maelstrom', count = 2, hostile = true},
  {p = 'hostage', id = 'boy', at = 'sunset', record = 'Character.victim'}, {p = 'escortee', id = 'boy-e', from = 'boy'}}
local function quest(stage, serial)
  return {pack = 'rescue', character = 'judy-alvarez', stage = stage, serial = serial, since = 99990, places = {sunset = sunset}, ['do'] = doList,
    script = {{when = 'squad:den:down', event = 'den-clear'}, {when = 'hostage:boy:freed', event = 'boy-free'}}, lines = {}, gaps = {}}
end
files[Play.PLAY] = serialize({version = 1, revision = 1, quests = {quest('in', 1)}})
game.vpos = {x = 100, y = 200 - 90, z = 10}
assert(play.restore() == true)
step(3); attachAll(); step(12)
local text = names()
assert(text:find('squad:den:spawned') and text:find('squad:den:hostile') and text:find('hostage:boy:down'), text)
for _, a in ipairs(actorList()) do if a.request.id:find('den') then a.dead = true end end
step(3)
text = names()
assert(text:find('squad:den:down') and text:find('den%-clear'), text)
game.vpos = {x = 100 + 2, y = 200, z = 10}
step(8)
text = names()
assert(text:find('hostage:boy:freed') and text:find('boy%-free'), text)
step(3); assert(game.calls.escorteeConfigure == 1)
assert(count(actorList()) == 3)
-- the next stage: everything goes, once each
files[Play.PLAY] = serialize({version = 1, revision = 2, quests = {quest('out', 2)}})
step(1.2)
local seen = {}
for _, id in ipairs(game.deleted) do assert(not seen[id], 'deleted twice: ' .. id); seen[id] = true end
assert(count(seen) >= 3, 'all three bodies of the first stage were removed: ' .. count(seen))
-- a world change drops everything without asking the game
local before = #game.deleted
play.abandon()
assert(#game.deleted == before)
`));

// ---- the natives, on a fake of the game's own objects ------------------------------------------------------------------------------------------------

const nativeHarness = `
local Natives = ${load('quest-world-action.lua')}
${base}
local calls = {}
local function rec(text) calls[#calls + 1] = text end
local function index(text) for i, c in ipairs(calls) do if c == text then return i end end return nil end
Enum = {new = function(kind, name) return name end}
CName = {new = function(name) return 'cn:' .. name end}
TweakDBID = {new = function(name) return {name = name, hash = name} end}
Vector4 = {new = function(x, y, z, w) return {x = x, y = y, z = z, w = w} end}
Quaternion = {BuildFromDirectionVector = function() return 'quat' end}
NewObject = function(kind) return {kind = kind} end
TDBID = {ToStringDEBUG = function(id) return 'Character.victim' end}
local state = {nextId = 1, entities = {}, pool = 100, dead = false, combatOk = true, role = 'AIRole', aggressive = false, godOk = true, poolOk = true}
local playerAgent = {}
function playerAgent:SetAttitudeTowards(other, att) rec('attitude player->npc ' .. att) end
local function newNpc(id)
  local npc = {id = id, tags = {}, attached = false}
  local agent = {att = {}}
  function agent:SetAttitudeTowards(other, att) rec('attitude npc->player ' .. att); self.att = att end
  function agent:GetAttitudeTowards(other) return 'EAIAttitude.' .. (self.att == 'AIA_Hostile' and 'AIA_Hostile' or 'AIA_Neutral') end
  local reaction = {}
  function reaction:GetReactionPreset() return {IsAggressive = function() return state.aggressive end} end
  function reaction:SetReactionPreset(p) rec('preset'); state.aggressive = true end
  function reaction:TriggerCombat(target) rec('TriggerCombat'); if not state.combatOk then error('refused') end end
  local ai = {}
  function ai:GetAIRole() return {IsA = function(_, name) return state.role == 'AINoRole' and name == 'AINoRole' end} end
  function ai:SetAIRole(role) rec('SetAIRole ' .. tostring(role.kind)) end
  function ai:OnAttach() rec('OnAttach') end
  function ai:SendCommand(cmd) rec('SendCommand ' .. tostring(cmd.kind)); return true end
  function ai:CancelCommand(cmd) rec('CancelCommand') end
  local tracker = {}
  function tracker:AddThreat() rec('AddThreat') end
  function npc:GetAttitudeAgent() return agent end
  function npc:GetStimReactionComponent() return reaction end
  function npc:GetAIControllerComponent() return ai end
  function npc:GetTargetTrackerComponent() return tracker end
  function npc:IsAttached() return self.attached end
  function npc:IsA(name) return name == 'NPCPuppet' end
  function npc:IsDeadNoStatPool() return state.dead end
  function npc:GetEntityID() return self.id end
  function npc:GetWorldPosition() return {x = 1, y = 2, z = 3} end
  function npc:GetRecordID() return {} end
  function npc:GetCurrentAppearanceName() return 'torn_jacket' end
  return npc
end
local player = {}
function player:GetAttitudeAgent() return playerAgent end
function player:GetWorldPosition() return {x = 10, y = 10, z = 0} end
function player:GetWorldForward() return {x = 1, y = 0, z = 0} end
local entitySystem = {}
function entitySystem:IsReady() return true end
function entitySystem:CreateEntity(spec)
  local id = {hash = tostring(state.nextId)}; state.nextId = state.nextId + 1
  local npc = newNpc(id); npc.tags = spec.tags; npc.spec = spec
  state.entities[id.hash] = npc
  rec('create')
  return id
end
function entitySystem:IsManaged(id) return state.entities[id.hash] ~= nil end
function entitySystem:GetEntity(id) return state.entities[id.hash] end
function entitySystem:IsTagged(id, tag) for _, t in ipairs(state.entities[id.hash].tags) do if t == tag then return true end end return false end
function entitySystem:DeleteEntity(id) rec('delete ' .. id.hash); state.entities[id.hash] = nil end
local godSystem = {}
function godSystem:AddGodMode(id, mode, source) rec('god on'); if not state.godOk then error('no') end end
function godSystem:HasGodMode() return state.godOk end
function godSystem:RemoveGodMode() rec('god off') end
local pools = {}
function pools:RequestSettingStatPoolValue(id, pool, value, who, percent) rec('pool ' .. value); if not state.poolOk then error('no') end; state.pool = value end
function pools:GetStatPoolValue() return state.pool end
local mounting = {}
function mounting:IsMountedToAnything() return false end
Game = {
  GetPlayer = function() return player end,
  GetDynamicEntitySystem = function() return entitySystem end,
  GetGodModeSystem = function() return godSystem end,
  GetStatPoolsSystem = function() return pools end,
  GetMountingFacility = function() return mounting end,
  GetStatsSystem = function() return {AddModifier = function() rec('stat modifier') end} end,
  GetSpatialQueriesSystem = function() return nil end,
  GetAINavigationSystem = function() return nil end,
  CreateEntityReference = function() return 'ref' end,
  NameToString = function(n) return n end,
}
RPGManager = {CreateStatModifier = function() return 'mod' end}
TweakDB = {GetRecord = function(_, id)
  return {IsA = function() return true end, IsCrowd = function() return false end, Affiliation = function() return {EnumName = function() return 'Maelstrom' end} end}
end}
TweakDBInterface = {GetReactionPresetRecord = function() return {IsAggressive = function() return true end} end}
ScriptedPuppet = {IsDefeated = function() return false end}
NPCPuppet = {IsInCombat = function() return false end, ChangeHighLevelState = function(npc, s) rec('state ' .. s) end}
AIActionHelper = {TryStartCombatWithTarget = function() rec('helper'); return true end}
local W = Natives.new({groups = {Maelstrom = 'maelstrom'}, log = log})
local function spawn(extra)
  local request = {id = 'pk:x', record = 'Character.victim', x = 1, y = 2, z = 3, tag = 'CyberpunkConvaiQuest:pk'}
  for k, v in pairs(extra or {}) do request[k] = v end
  local handle = assert(W.actorSpawn(request))
  state.entities[handle.id.hash].attached = true
  return handle
end
`;
const withNatives = code => run(`${nativeHarness}\n${code}`);

test('natives: a spawn carries the shared tag and the quest tag and is nonpersistent, a bad record or place is refused', () => withNatives(`
local handle = assert(W.actorSpawn({id = 'pk:x', record = 'Character.victim', x = 1, y = 2, z = 3, tag = 'CyberpunkConvaiQuest:pk', appearance = 'torn_jacket'}))
local npc = state.entities[handle.id.hash]
assert(npc.tags[1] == 'cn:CyberpunkConvaiQuest' and npc.tags[2] == 'cn:CyberpunkConvaiQuest:pk')
assert(npc.spec.persistState == false and npc.spec.persistSpawn == false and npc.spec.alwaysSpawned == false)
assert(W.actorSpawn({record = 'Bad', x = 1, y = 1, z = 1}) == nil)
assert(W.actorSpawn({record = 'Character.victim', x = 1}) == nil)
assert(W.actorState(handle) == nil, 'not attached yet')
npc.attached = true
local read = W.actorState(handle)
assert(read.dead == false and read.defeated == false and read.health == 100 and read.combat == false and read.x == 1)
local info = W.actorInfo(handle); assert(info.record == 'Character.victim' and info.appearance == 'torn_jacket')
`));

test('natives: only the module own spawns are ever acted on, a foreign entity id is read, armed, drained and deleted by nothing', () => withNatives(`
local foreign = {hash = '777'}
state.entities['777'] = newNpc(foreign); state.entities['777'].attached = true; state.entities['777'].tags = {'cn:CyberpunkConvaiQuest'}
local handle = {kind = 'extra', id = foreign}
calls = {}
assert(W.actorState(handle) == nil and W.squadArm(handle) == false and W.hostageDrain(handle) == false and W.hostageConfigure(handle) == false)
assert(W.escorteeLeash(handle) == false and W.escorteeBolt(handle) == false)
W.actorDelete(handle)
assert(#calls == 0, table.concat(calls, ','))
assert(W.actorState(foreign) == nil, 'a raw id is not a handle')
`));

test('natives: the hostile recipe in order, attitude both ways, a live role, the aggressive preset, the combat trigger, the forced state, then the shared threat', () => withNatives(`
local handle = spawn()
calls = {}
local ok, notes = W.squadArm(handle, {shared = true})
assert(ok == true and notes == '', notes)
local order = {'attitude npc->player AIA_Hostile', 'attitude player->npc AIA_Hostile', 'preset', 'TriggerCombat', 'state Combat', 'AddThreat'}
local last = 0
for _, step in ipairs(order) do
  local at = index(step)
  assert(at and at > last, step .. ' is missing or out of order: ' .. table.concat(calls, ' | '))
  last = at
end
calls = {}
W.squadArm(handle)
assert(index('AddThreat') == nil and index('preset') == nil, 'no shared threat unless asked, an aggressive preset stays')
`));

test('natives: a refused piece is a note and not an error, no live role is noted, the combat helper is the second ask', () => withNatives(`
local handle = spawn()
state.role = 'AINoRole'; state.combatOk = false
local ok, notes = W.squadArm(handle)
assert(ok == true and notes == 'role' and index('helper'), tostring(notes))
AIActionHelper.TryStartCombatWithTarget = function() error('no') end
NPCPuppet.ChangeHighLevelState = function() error('no') end
ok, notes = W.squadArm(handle)
assert(ok == false and notes:find('combat'), notes)
`));

test('natives: the hostage is configured with god mode first and drained to a floor above zero afterwards, protection and the raise come back', () => withNatives(`
local handle = spawn()
calls = {}
assert(W.hostageConfigure(handle) == true)
assert(index('god on'))
assert(W.hostageDrain(handle) == true)
assert(index('god on') < index('pool 10'), table.concat(calls, ','))
assert(state.pool == 10 and state.pool > 0)
assert(W.actorState(handle).health == 10)
assert(W.hostageProtect(handle, false) == true and index('god off'))
assert(W.hostageRaise(handle) == true and state.pool == 100)
state.godOk = false
local ok, notes = W.hostageConfigure(handle)
assert(ok == false and notes:find('godmode'))
-- deleting a protected body gives the protection back first
W.hostageConfigure(spawn({id = 'pk:y'}))
calls = {}
local second = spawn({id = 'pk:z'})
state.godOk = true; W.hostageConfigure(second); calls = {}
W.actorDelete(second)
assert(index('god off') and index('god off') < index('delete ' .. second.id.hash), table.concat(calls, ','))
`));

test('natives: the escortee gets a follower role when it has none, a follow command when it has one, bolts to fear and is calmed back', () => withNatives(`
local handle = spawn()
state.role = 'AINoRole'
calls = {}
assert(W.escorteeConfigure(handle, {bonus = 1.5}) == true)
assert(index('stat modifier') and index('SetAIRole AIFollowerRole'))
assert(W.escorteeBolt(handle) == true and index('state Fear') and index('SetAIRole AINoRole'))
calls = {}
assert(W.escorteeCalm(handle) == true and index('state Relaxed') and index('SetAIRole AIFollowerRole'))
state.role = 'AIRole'
local other = spawn({id = 'pk:o'})
calls = {}
assert(W.escorteeConfigure(other, {}) == true and index('SendCommand AIFollowTargetCommand'))
assert(W.escorteeFollow(other) == true and index('CancelCommand'), 'the earlier command is replaced')
assert(W.escorteeLeash(other) == true and index('SendCommand AITeleportCommand'))
`));

test('natives: replace spawns a fresh copy with the old record and appearance, a body that cannot be read is refused', () => withNatives(`
local handle = spawn()
local fresh, why = W.actorReplace(handle, {id = 'pk:new', x = 5, y = 5, z = 5, tag = 'CyberpunkConvaiQuest:pk'})
assert(fresh ~= nil, why)
local npc = state.entities[fresh.id.hash]
assert(npc.spec.recordID.name == 'Character.victim')
assert(W.actorReplace({kind = 'extra', id = {hash = '555'}}, {x = 1, y = 1, z = 1}) == nil)
`));

test('natives: out of sight uses the invitation test when given, nil when nothing can tell', () => withNatives(`
local W2 = Natives.new({hidden = function(position) return position.x == 1 end})
assert(W2.hiddenFromPlayer(1, 2, 3) == true and W2.hiddenFromPlayer(5, 2, 3) == false)
assert(W2.hiddenFromPlayer(1, nil, 3) == nil)
local W3 = Natives.new({})
Game.GetSpatialQueriesSystem = function() return {SyncRaycastByCollisionGroup = function() return false end} end
assert(W3.hiddenFromPlayer(100, 100, 3) == false, 'in view and no wall')
assert(W3.hiddenFromPlayer(-100, 0, 3) == true, 'behind V')
Game.GetPlayer = function() error('no player') end
assert(W3.hiddenFromPlayer(100, 100, 3) == nil)
`));

// ---- hygiene -----------------------------------------------------------------------------------------------------------------------------------------

test('the modules are plain Lua 5.1 with no semicolon in a comment, no per-frame hook, and name no other mod', () => {
  for (const name of ['quest-prims-action.lua', 'quest-world-action.lua']) {
    const text = source(name);
    assert.ok(!/\bgoto\b|table\.unpack|bit32/.test(text), name);
    assert.ok(!/onUpdate|registerForEvent|GameSession|\bAMM\b/i.test(text), name + ' has a per-frame hook or names another mod');
    for (const line of text.split('\n')) assert.ok(!/--.*;/.test(line), 'no semicolon in a comment: ' + line);
  }
});
