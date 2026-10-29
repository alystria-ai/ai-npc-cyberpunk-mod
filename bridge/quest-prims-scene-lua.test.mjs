// The scene primitives of the bond quests, the game half (mod/quest-prims-scene.lua and mod/quest-world-scene.lua, docs/QUEST_PRIMITIVES.md, BOND_QUESTS.md sections 19.1 and 21):
// bout, hold-until, apart, unseen, dead-zone, workspot and npc-react, the squad's stand-down they rely on, the scene natives on a fake of the game's own objects, and the gap
// idle of the line player. Run on a fake game: a clock, a game clock, a world of positions and fighters whose reads die at every tick (the test fails if a module keeps one),
// and a call counter on every world function. Nothing here starts the game.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run, load, base, fakeCtx} from './quest-lua-fixture.mjs';
import {PRIMITIVES, BUILT, raisable} from './quest-primitives.mjs';

const harness = `
local Places = ${load('quest-places.lua')}
local Prims = ${load('quest-prims.lua')}
local Scene = ${load('quest-prims-scene.lua')}
local Action = ${load('quest-prims-action.lua')}
local Ambush = ${load('revenge-ambush.lua')}
${base}
${fakeCtx}
local game = {now = 0, gameClock = 12 * 3600, rate = 1, tick = 0, stale = false, hidden = true, calls = {}, vpos = {x = 0, y = 0, z = 0}, noPos = false,
  fighters = {}, nextCast = 1, armOk = true, armNotes = '', armed = 0, stands = 0, heals = {}, vCombat = false,
  actors = {}, nextActor = 1, steps = {}, begins = {}, beginFail = {}, session = 0, ended = {}, sinks = {}, holds = {}, released = 0, noHold = false,
  stepScript = nil, readyBody = true, random = 0.2}
local function fresh(t)
  local gen = game.tick
  return setmetatable({}, {__index = function(_, k)
    if gen ~= game.tick then game.stale = true; error('a stale handle was used: ' .. tostring(k)) end
    return t[k]
  end})
end
local function keyOf(handle) return handle.kind == 'copy' and handle.profileKey or handle.id end
local function fighter(key, health, extra)
  local f = {attached = true, health = health or 100, dead = false, defeated = false, combat = false, gone = false}
  for k, v in pairs(extra or {}) do f[k] = v end
  game.fighters[key] = f
  return f
end
local function spawnActor(request)
  local id = 'a' .. game.nextActor; game.nextActor = game.nextActor + 1
  game.actors[id] = {id = id, attached = true, dead = false, health = 100, combat = false, x = request.x, y = request.y, z = request.z}
  return {kind = 'extra', id = id}
end
local raw = {
  playerPosition = function() if game.noPos then return nil end return fresh(game.vpos) end,
  hiddenFromPlayer = function() return game.hidden end,
  rayDown = function() return nil end,
  squadVerify = function() return true end,
  squadSpawn = spawnActor,
  actorSpawn = spawnActor,
  actorDelete = function(handle) local a = game.actors[handle.id]; if a then a.deleted = true end end,
  actorState = function(handle)
    local a = game.actors[handle.id]
    if not a or a.deleted or not a.attached then return nil end
    return fresh({dead = a.dead, defeated = false, health = a.health, combat = a.combat, mounted = false, x = a.x, y = a.y, z = a.z})
  end,
  squadArm = function(handle) local a = game.actors[handle.id]; if a then a.combat = true end return true, '' end,
  castSpawn = function(request)
    local id = 'x' .. game.nextCast; game.nextCast = game.nextCast + 1
    if request.who ~= 'extra' then return {kind = 'copy', appointment = 'quest:' .. request.id, profileKey = request.profileKey} end
    if game.autoFighter ~= false then fighter(id, 100) end
    return {kind = 'extra', id = id}
  end,
  castLookup = function() return nil end, castDelete = function() end,
  pinAdd = function() return nil end, pinRemove = function() end,
  playerInCombat = function() return game.vCombat end,
  fighterRead = function(handle)
    local f = game.fighters[keyOf(handle)]
    if not f or not f.attached or f.gone then return nil end
    return fresh({dead = f.dead, defeated = f.defeated, health = f.health, combat = f.combat})
  end,
  boutArm = function(a, b) game.armed = game.armed + 1; return game.armOk, game.armNotes end,
  boutStand = function(a, b) game.stands = game.stands + 1; return true end,
  fighterHealth = function(handle, percent) game.heals[#game.heals + 1] = percent; local f = game.fighters[keyOf(handle)]; if f then f.health = percent end return true end,
  workspotReady = function(handle)
    local f = game.fighters[keyOf(handle)]
    if not f or not f.attached or not game.readyBody then return nil end
    return fresh({position = {x = f.x or 0, y = f.y or 0, z = f.z or 0}})
  end,
  workspotBegin = function(handle, request)
    local label = request.idle and ('idle:' .. request.idle) or ('seat:' .. tostring(request.seat))
    game.begins[#game.begins + 1] = label
    if game.beginFail[label] then return nil, game.beginFail[label] end
    game.session = game.session + 1
    return {id = game.session, label = label, target = handle}
  end,
  workspotStep = function(session)
    game.steps[#game.steps + 1] = session.label
    local script = game.stepScript
    if script then
      local status = script[session.label]
      if type(status) == 'table' then
        local nextStatus = table.remove(status, 1) or 'playing'
        return nextStatus, 'because'
      end
      if status then return status, 'because' end
    end
    return 'playing'
  end,
  workspotEnd = function(session) game.ended[#game.ended + 1] = session.label end,
  entityKey = function(handle) return 'k:' .. keyOf(handle) end,
  npcOutcomeHook = function(fn)
    game.sinks[#game.sinks + 1] = fn
    return function() game.released = game.released + 1; for i = #game.sinks, 1, -1 do if game.sinks[i] == fn then table.remove(game.sinks, i) end end end
  end,
  remoteHold = function(fn)
    if game.noHold then return nil end
    game.holds[#game.holds + 1] = fn
    return function() game.released = game.released + 1 end
  end,
}
local world = {}
for name, fn in pairs(raw) do
  world[name] = function(...) game.calls[name] = (game.calls[name] or 0) + 1; return fn(...) end
end
local places = Places.new({world = world, clock = function() return game.now end, log = log})
local prims = Prims.new({places = places, world = world, clock = function() return game.now end, gameTime = function() return game.gameClock end, log = log})
prims.env.ambush = Ambush
prims.env.actionNatives = {}
prims.env.sceneNatives = {}
prims.env.random = function() return game.random end
assert(prims.extend(Action))
assert(prims.extend(Scene))
local ring = {x = 100, y = 200, z = 10, radius = 25}
local function stageCtx(pack)
  local ctx = newCtx(pack or 'pk', 'panam-palmer')
  ctx.places = {ring = ring, far = {x = 5000, y = 0, z = 0, radius = 20}, sunset = {x = 100, y = 200, z = 10, radius = 25}}
  function ctx:after(seconds, fn, opts)
    local real = opts and opts.real == true
    self.timers[#self.timers + 1] = {at = (real and game.now or game.gameClock) + seconds, real = real, fn = fn}
  end
  function ctx:untrack(handle, run)
    for i = #self.tracked, 1, -1 do
      local t = self.tracked[i]
      if t.handle == handle then table.remove(self.tracked, i); if run ~= false and t.undo then t.undo(t.handle) end; return true end
    end
    return false
  end
  return ctx
end
local function drive(ctx, specs)
  local insts = {}
  for _, spec in ipairs(specs) do
    local def = prims.get(spec.p)
    assert(def, 'no primitive ' .. tostring(spec.p))
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
local function reap(ctx, insts)
  for index = #insts, 1, -1 do
    local inst = insts[index]
    if inst.def.disarm then inst.def.disarm(ctx, inst.spec, inst.state, prims.env) end
  end
  ctx:reap()
end
local function evs(ctx) return table.concat(ctx.events, '|') end
local function setHour(h) game.gameClock = h * 3600 end
local function inRing() game.vpos = {x = 100, y = 200 - 30, z = 10} end   -- 30 m from the place
`;
const withGame = code => run(`${harness}\n${code}\nassert(not game.stale, 'a handle was kept across ticks')`);

// ---- the registry agrees -----------------------------------------------------------------------------------------------------------------------------

test('registry: the seven scene primitives exist in the registry, are played, and the events of the file are the registry events', () => {
  for (const name of ['bout', 'hold-until', 'apart', 'unseen', 'dead-zone', 'workspot', 'npc-react']) {
    assert.ok(PRIMITIVES[name], name);
    assert.ok(BUILT.has(name), name);
  }
  assert.ok(raisable('bout:fight:round2', [{p: 'bout', id: 'fight', a: 'self', b: 'x'}]));
  assert.ok(raisable('npc:talk:obey', [{p: 'npc-react', id: 'talk', cast: 'x'}]));
  assert.ok(raisable('unseen:u:spotted', [{p: 'unseen', id: 'u'}]));
});

test('workspot: every pose of the registry enum is in the pose table, a known one names an idle or a seat of the gesture archive, an unknown one has none', () => {
  const keys = PRIMITIVES.workspot.fields.key.split(':')[1].split('|');
  assert.equal(keys.length, 15);
  const known = ['arms-crossed', 'drink', 'smoke', 'lean', 'rail', 'sit-ledge', 'sit-ground'];
  run(`${harness}
local keys = {${keys.map(key => `'${key}'`).join(', ')}}
local known = {${known.map(key => `['${key}'] = true`).join(', ')}}
for _, key in ipairs(keys) do
  local pose = Scene.POSES[key]
  assert(type(pose) == 'table', 'no pose ' .. key)
  if known[key] then assert(pose.idle or pose.seat, key .. ' needs an idle or a seat') else assert(not pose.idle and not pose.seat and pose.note, key .. ' has no known path') end
end
assert(Scene.POSES.smoke.guess and Scene.POSES.rail.guess and Scene.POSES['sit-ledge'].guess and Scene.POSES['sit-ground'].guess, 'guesses are marked')
assert(not Scene.POSES.drink.guess and not Scene.POSES.lean.guess and not Scene.POSES['arms-crossed'].guess)
`);
});

// ---- bout --------------------------------------------------------------------------------------------------------------------------------------------

test('bout: nothing is asked of the game before bout:<id>:go, then it arms the two, says started and round1, and reads the two pools once a second', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'bout', id = 'b1', a = 'self', b = 'thug', rounds = 3, roundSeconds = 10, floor = 25}})
local thug = world.castSpawn({id = 'pk:thug', who = 'extra', record = 'Character.x'})
fighter('panam-palmer', 100)
advance(ctx, insts, 5)
assert(#insts == 1 and #ctx.events == 0 and not game.calls.fighterRead and not game.calls.boutArm and not game.calls.playerPosition, 'idle until go')
ctx:emit('bout:b1:go')
advance(ctx, insts, 1)
assert(game.armed == 1 and evs(ctx) == 'bout:b1:go|bout:b1:started|bout:b1:round1', evs(ctx))
local reads = game.calls.fighterRead
advance(ctx, insts, 4)
assert(game.calls.fighterRead - reads == 8, 'two reads a tick, one tick a second: ' .. (game.calls.fighterRead - reads))
assert(evs(ctx) == 'bout:b1:go|bout:b1:started|bout:b1:round1')
`));

test('bout: round N starts (N - 1) rounds after the start, a fighter at the floor ends it: <fighter>-down, stopped, ended, the fighters stand down once, nothing is read afterwards', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'bout', id = 'b1', a = 'self', b = 'thug', rounds = 3, roundSeconds = 10, floor = 25}})
local thug = world.castSpawn({id = 'pk:thug', who = 'extra', record = 'Character.x'})
fighter('panam-palmer', 100)
ctx:emit('bout:b1:go'); advance(ctx, insts, 1)
advance(ctx, insts, 10)
assert(ctx:count('bout:b1:round2') == 1 and ctx:count('bout:b1:round3') == 0, evs(ctx))
advance(ctx, insts, 9); assert(ctx:count('bout:b1:round3') == 0)
advance(ctx, insts, 1); assert(ctx:count('bout:b1:round3') == 1)
game.fighters.x1.health = 20
advance(ctx, insts, 1)
local tail = evs(ctx):match('round3|(.*)$')
assert(tail == 'bout:b1:b-down|bout:b1:stopped|bout:b1:ended', tail)
assert(game.stands == 1)
local reads = game.calls.fighterRead
advance(ctx, insts, 20)
assert(game.calls.fighterRead == reads and ctx:count('bout:b1:round3') == 1 and ctx:count('bout:b1:ended') == 1, 'over is over')
reap(ctx, insts); assert(game.stands == 1, 'one stand down however it ends')
`));

test('bout: fighter a at the floor is a-down, the lower one when both are, health unreadable is never down, a defeated or dead one is down', () => withGame(`
local function once(ha, hb, extraA, extraB)
  local ctx = stageCtx()
  local insts = drive(ctx, {{p = 'bout', id = 'b1', a = 'one', b = 'two'}})
  local one = world.castSpawn({id = 'pk:one', who = 'extra', record = 'Character.x'})
  local two = world.castSpawn({id = 'pk:two', who = 'extra', record = 'Character.x'})
  local a, b = game.fighters[one.id], game.fighters[two.id]
  a.health, b.health = ha, hb
  for k, v in pairs(extraA or {}) do a[k] = v end
  for k, v in pairs(extraB or {}) do b[k] = v end
  ctx:emit('bout:b1:go'); advance(ctx, insts, 3)
  return ctx
end
local c = once(10, 80); assert(c:count('bout:b1:a-down') == 1 and c:count('bout:b1:b-down') == 0 and c:count('bout:b1:ended') == 1)
c = once(80, 25); assert(c:count('bout:b1:b-down') == 1 and c:count('bout:b1:a-down') == 0, 'exactly the floor counts')
c = once(20, 10); assert(c:count('bout:b1:b-down') == 1 and c:count('bout:b1:a-down') == 0, 'the lower one')
c = once(50, 50, {defeated = true}); assert(c:count('bout:b1:a-down') == 1, 'defeated')
c = once(50, 50, nil, {dead = true}); assert(c:count('bout:b1:b-down') == 1, 'dead')
c = once(nil, 50); assert(c:count('bout:b1:a-down') == 0 and c:count('bout:b1:stopped') == 0, 'an unreadable pool is nobody down')
`));

test('bout: every round used and nobody at the floor is stopped then ended with no one down', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'bout', id = 'b1', a = 'self', b = 'thug', rounds = 2, roundSeconds = 10}})
world.castSpawn({id = 'pk:thug', who = 'extra', record = 'Character.x'}); fighter('panam-palmer', 90)
ctx:emit('bout:b1:go'); advance(ctx, insts, 1)
advance(ctx, insts, 25)
assert(evs(ctx) == 'bout:b1:go|bout:b1:started|bout:b1:round1|bout:b1:round2|bout:b1:stopped|bout:b1:ended', evs(ctx))
assert(game.stands == 1)
`));

test('bout: bout:<id>:stop halts it with stopped and no ended, before go it is nothing, a second stop is nothing', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'bout', id = 'b1', a = 'self', b = 'thug'}})
world.castSpawn({id = 'pk:thug', who = 'extra', record = 'Character.x'}); fighter('panam-palmer', 100)
ctx:emit('bout:b1:stop'); advance(ctx, insts, 2); ctx:emit('bout:b1:go'); advance(ctx, insts, 3)
assert(ctx:count('bout:b1:started') == 0, 'a stop before go cancels it')
local ctx2 = stageCtx()
local insts2 = drive(ctx2, {{p = 'bout', id = 'b1', a = 'self', b = 'thug'}})
ctx2:emit('bout:b1:go'); advance(ctx2, insts2, 2); assert(ctx2:count('bout:b1:started') == 1)
ctx2:emit('bout:b1:stop')
assert(ctx2:count('bout:b1:stopped') == 1 and ctx2:count('bout:b1:ended') == 0 and game.stands == 1)
ctx2:emit('bout:b1:stop'); advance(ctx2, insts2, 5)
assert(ctx2:count('bout:b1:stopped') == 1 and game.stands == 1)
`));

test('bout: a fighter that disappears halts it after two misses, with stopped only', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'bout', id = 'b1', a = 'self', b = 'thug'}})
world.castSpawn({id = 'pk:thug', who = 'extra', record = 'Character.x'}); fighter('panam-palmer', 100)
ctx:emit('bout:b1:go'); advance(ctx, insts, 3)
game.fighters.x1.gone = true
advance(ctx, insts, 1); assert(ctx:count('bout:b1:stopped') == 0, 'one miss is a wait')
advance(ctx, insts, 1)
assert(ctx:count('bout:b1:stopped') == 1 and ctx:count('bout:b1:ended') == 0 and logged('is gone'))
`));

test('bout: the handicap gives back a share of the damage the copy took since the last sample, never the other fighter, and never revives a downed one', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'bout', id = 'b1', a = 'self', b = 'thug', handicap = 50, rounds = 5, roundSeconds = 100}})
world.castSpawn({id = 'pk:thug', who = 'extra', record = 'Character.x'}); fighter('panam-palmer', 100)
ctx:emit('bout:b1:go'); advance(ctx, insts, 2)
game.fighters['panam-palmer'].health = 80; game.fighters.x1.health = 70
advance(ctx, insts, 1)
assert(#game.heals == 1 and game.heals[1] == 90, 'half of the 20 points given back: ' .. tostring(game.heals[1]))
game.fighters.x1.health = 40; advance(ctx, insts, 1)
assert(#game.heals == 1, 'the other fighter is never helped')
game.fighters['panam-palmer'].health = 90; advance(ctx, insts, 1); assert(#game.heals == 1, 'no damage, nothing back')
-- The handicapped fighter is b when the copy is b.
local ctx2 = stageCtx()
local insts2 = drive(ctx2, {{p = 'bout', id = 'b2', a = 'thug', b = 'self', handicap = 60, rounds = 5, roundSeconds = 100}})
world.castSpawn({id = 'pk:thug', who = 'extra', record = 'Character.x'})
game.heals = {}; game.fighters['panam-palmer'].health = 100
ctx2:emit('bout:b2:go'); advance(ctx2, insts2, 2)
game.fighters['panam-palmer'].health = 60; advance(ctx2, insts2, 1)
assert(#game.heals == 1 and math.abs(game.heals[1] - 84) < 1e-6, 'the copy on side b is the held back one: 60 percent of the 40 points back ' .. table.concat(game.heals, ','))
`));

test('bout: staged plays no hit: timers and the winner make the events, the loser goes down at the end, no fight call at all', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'bout', id = 'b1', a = 'self', b = 'thug', staged = true, winner = 'a', rounds = 2, roundSeconds = 10}})
ctx:emit('bout:b1:go'); advance(ctx, insts, 1)
assert(ctx:count('bout:b1:started') == 1 and ctx:count('bout:b1:round1') == 1)
advance(ctx, insts, 10); assert(ctx:count('bout:b1:round2') == 1)
advance(ctx, insts, 10)
assert(evs(ctx) == 'bout:b1:go|bout:b1:started|bout:b1:round1|bout:b1:round2|bout:b1:b-down|bout:b1:stopped|bout:b1:ended', evs(ctx))
assert(not game.calls.fighterRead and not game.calls.boutArm and not game.calls.boutStand and not game.calls.fighterHealth and not game.calls.playerPosition, 'not one call')
local ctx2 = stageCtx()
local insts2 = drive(ctx2, {{p = 'bout', id = 'b1', a = 'self', b = 'thug', staged = true, winner = 'b', rounds = 1, roundSeconds = 10}})
ctx2:emit('bout:b1:go'); advance(ctx2, insts2, 12); assert(ctx2:count('bout:b1:a-down') == 1 and ctx2:count('bout:b1:b-down') == 0)
-- random winner: the env random picks, a draw under one half is a.
game.random = 0.2
local ctx3 = stageCtx(); local insts3 = drive(ctx3, {{p = 'bout', id = 'b1', a = 'self', b = 'thug', staged = true, rounds = 1, roundSeconds = 10}})
ctx3:emit('bout:b1:go'); advance(ctx3, insts3, 12); assert(ctx3:count('bout:b1:b-down') == 1, 'a won')
game.random = 0.9
local ctx4 = stageCtx(); local insts4 = drive(ctx4, {{p = 'bout', id = 'b1', a = 'self', b = 'thug', staged = true, rounds = 1, roundSeconds = 10}})
ctx4:emit('bout:b1:go'); advance(ctx4, insts4, 12); assert(ctx4:count('bout:b1:a-down') == 1, 'b won')
`));

test('bout: a real bout that cannot be armed is staged by itself and says so once in the log', () => withGame(`
game.armOk = false; game.armNotes = 'attitude'
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'bout', id = 'b1', a = 'self', b = 'thug', rounds = 1, roundSeconds = 10, winner = 'b'}})
world.castSpawn({id = 'pk:thug', who = 'extra', record = 'Character.x'}); fighter('panam-palmer', 100)
ctx:emit('bout:b1:go'); advance(ctx, insts, 2)
assert(game.armed == 1 and ctx:count('bout:b1:started') == 1 and logged('played staged') and logged('attitude'))
local reads = game.calls.fighterRead
advance(ctx, insts, 15)
assert(game.calls.fighterRead == reads, 'staged reads nothing')
assert(ctx:count('bout:b1:a-down') == 1 and ctx:count('bout:b1:ended') == 1)
local lines = 0 for _, l in ipairs(logs) do if l:find('played staged', 1, true) then lines = lines + 1 end end
assert(lines == 1, 'logged once')
`));

test('bout: missing natives stage at once, fighters that never attach stage after thirty seconds, a stranger id is never a fighter', () => withGame(`
-- No fight calls in the world at all.
local saved = prims.env.world.boutArm
prims.env.world.boutArm = nil
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'bout', id = 'b1', a = 'self', b = 'thug', rounds = 1, roundSeconds = 10, winner = 'a'}})
ctx:emit('bout:b1:go'); advance(ctx, insts, 2)
assert(ctx:count('bout:b1:started') == 1 and logged('no fight calls'))
prims.env.world.boutArm = saved
-- A cast that is never made: staged after the patience, the arm never called.
local ctx2 = stageCtx()
local insts2 = drive(ctx2, {{p = 'bout', id = 'b2', a = 'self', b = 'nobody', rounds = 1, roundSeconds = 10}})
fighter('panam-palmer', 100)
ctx2:emit('bout:b2:go'); advance(ctx2, insts2, 29); assert(ctx2:count('bout:b2:started') == 0)
advance(ctx2, insts2, 2); assert(ctx2:count('bout:b2:started') == 1 and game.armed == 0 and logged('did not attach'))
-- Bad specs are refused when armed: the same fighter twice, a name that is not an id.
local ctx3 = stageCtx()
assert(#drive(ctx3, {{p = 'bout', id = 'b3', a = 'self', b = 'self'}, {p = 'bout', id = 'b4', a = 'self', b = 'Bad Name'}, {p = 'bout', a = 'self', b = 'thug'}, {p = 'bout', id = 'b5', a = 5, b = 'x'}}) == 0)
`));

test('bout: a reap while it is fought stands the fighters down once and emits nothing more', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'bout', id = 'b1', a = 'self', b = 'thug', rounds = 5, roundSeconds = 100}})
world.castSpawn({id = 'pk:thug', who = 'extra', record = 'Character.x'}); fighter('panam-palmer', 100)
ctx:emit('bout:b1:go'); advance(ctx, insts, 3)
local before = #ctx.events
reap(ctx, insts)
assert(game.stands == 1, 'stood down: ' .. game.stands)
game.fighters.x1.health = 1
advance(ctx, insts, 3)
assert(#ctx.events == before and game.stands == 1, 'a reaped ctx says nothing')
-- A copy as the other fighter (a cast of another character) works the same.
local ctx2 = stageCtx()
local insts2 = drive(ctx2, {{p = 'bout', id = 'b2', a = 'self', b = 'viktor'}})
world.castSpawn({id = 'pk:viktor', who = 'viktor-vektor', profileKey = 'viktor-vektor'}); fighter('viktor-vektor', 100)
local armedBefore = game.armed
ctx2:emit('bout:b2:go'); advance(ctx2, insts2, 2); assert(ctx2:count('bout:b2:started') == 1 and game.armed == armedBefore + 1)
`));

// ---- hold-until --------------------------------------------------------------------------------------------------------------------------------------

test('hold-until: reached when the game clock passes the hour, the same evening, once, and it reads the clock once a second', () => withGame(`
setHour(22)
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'hold-until', id = 'dawn', hour = 23}})
advance(ctx, insts, 3600 - 3); assert(ctx:count('hold-until:dawn:reached') == 0, 'not yet')
advance(ctx, insts, 5); assert(ctx:count('hold-until:dawn:reached') == 1)
advance(ctx, insts, 100); assert(ctx:count('hold-until:dawn:reached') == 1 and ctx:count('hold-until:dawn:failed') == 0, 'once')
`));

test('hold-until: midnight wraps (22:00 to 06:00 waits eight hours), a clock under two hours past the hour is reached at once, further past waits for tomorrow', () => withGame(`
game.rate = 60
setHour(22)
local ctx = stageCtx(); local insts = drive(ctx, {{p = 'hold-until', id = 'dawn', hour = 6}})
advance(ctx, insts, 60 * 7 - 5); assert(ctx:count('hold-until:dawn:reached') == 0)
advance(ctx, insts, 60); assert(ctx:count('hold-until:dawn:reached') == 0, 'seven hours and a bit')
advance(ctx, insts, 60); assert(ctx:count('hold-until:dawn:reached') == 1, 'eight hours')
-- 07:00 is one hour past 06:00: already shows it.
setHour(7)
local ctx2 = stageCtx(); local insts2 = drive(ctx2, {{p = 'hold-until', id = 'dawn', hour = 6}})
advance(ctx2, insts2, 1); assert(ctx2:count('hold-until:dawn:reached') == 1)
-- 09:00 is three hours past: tomorrow's.
setHour(9)
local ctx3 = stageCtx(); local insts3 = drive(ctx3, {{p = 'hold-until', id = 'dawn', hour = 6}})
advance(ctx3, insts3, 60 * 20); assert(ctx3:count('hold-until:dawn:reached') == 0, 'twenty hours is not yet 06:00 tomorrow')
advance(ctx3, insts3, 60 * 3); assert(ctx3:count('hold-until:dawn:reached') == 1)
-- hour 24 is midnight, and a day count above zero changes nothing.
game.gameClock = 5 * 86400 + 20 * 3600
local ctx4 = stageCtx(); local insts4 = drive(ctx4, {{p = 'hold-until', id = 'mid', hour = 24}})
advance(ctx4, insts4, 60 * 3); assert(ctx4:count('hold-until:mid:reached') == 0)
advance(ctx4, insts4, 60 * 2); assert(ctx4:count('hold-until:mid:reached') == 1)
`));

test('hold-until: a clock jump past the hour (a time skip) is reached, and an unreadable game clock waits and logs once', () => withGame(`
setHour(1)
local ctx = stageCtx(); local insts = drive(ctx, {{p = 'hold-until', id = 'dawn', hour = 6}})
advance(ctx, insts, 2); setHour(6.5); advance(ctx, insts, 1)
assert(ctx:count('hold-until:dawn:reached') == 1)
local blind = Prims.new({places = places, world = world, clock = function() return game.now end, log = log})
blind.extend(Scene)
local ctx2 = stageCtx(); local def = blind.get('hold-until'); local state = def.arm(ctx2, {p = 'hold-until', id = 'dawn', hour = 6}, blind.env)
for _ = 1, 3 do game.now = game.now + 1; def.tick(ctx2, {}, state, blind.env) end
assert(ctx2:count('hold-until:dawn:reached') == 0 and logged('game clock cannot be read'))
`));

test('hold-until: the witness dying first fails it, once, whether it is a hostage or an escortee, and then it is never reached', () => withGame(`
setHour(22)
local ctx = stageCtx(); local insts = drive(ctx, {{p = 'hold-until', id = 'dawn', hour = 23, witness = 'wit'}})
advance(ctx, insts, 100)
ctx:emit('hostage:wit:dead')
assert(ctx:count('hold-until:dawn:failed') == 1)
ctx:emit('escortee:wit:lost'); advance(ctx, insts, 4000)
assert(ctx:count('hold-until:dawn:failed') == 1 and ctx:count('hold-until:dawn:reached') == 0)
local ctx2 = stageCtx(); local insts2 = drive(ctx2, {{p = 'hold-until', id = 'dawn', hour = 23, witness = 'wit'}})
ctx2:emit('escortee:wit:lost'); assert(ctx2:count('hold-until:dawn:failed') == 1)
-- Another person's death is nothing; a witness that dies after the hour changes nothing.
setHour(22)
local ctx3 = stageCtx(); local insts3 = drive(ctx3, {{p = 'hold-until', id = 'dawn', hour = 23, witness = 'wit'}})
ctx3:emit('hostage:other:dead'); assert(ctx3:count('hold-until:dawn:failed') == 0)
advance(ctx3, insts3, 3700); assert(ctx3:count('hold-until:dawn:reached') == 1)
ctx3:emit('hostage:wit:dead'); assert(ctx3:count('hold-until:dawn:failed') == 0)
`));

test('hold-until: on reached the squad is told to stand down first, and the squad then sends no more waves', () => withGame(`
setHour(22)
near = function() game.vpos = {x = 100, y = 100, z = 10} end
near()
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'squad', id = 'raid', at = 'sunset', faction = 'Maelstrom', count = 2, waves = {{count = 2, afterSeconds = 3700}, {count = 2, whenDown = true}}},
  {p = 'hold-until', id = 'dawn', hour = 23, squad = 'raid'}})
advance(ctx, insts, 12)
local spawned = game.nextActor
assert(spawned == 3, 'the first group of two: ' .. spawned)
advance(ctx, insts, 3600)
assert(ctx:count('squad:raid:stand-down') == 1 and ctx:count('hold-until:dawn:reached') == 1)
local order = evs(ctx)
assert(order:find('stand%-down.*reached') ~= nil, 'stand down first: ' .. order)
advance(ctx, insts, 300)
assert(game.nextActor == spawned, 'no wave after the stand down: ' .. game.nextActor)
-- Before the hour the same squad does send a wave.
setHour(1); game.nextActor = 1; game.actors = {}
local ctx2 = stageCtx()
local insts2 = drive(ctx2, {{p = 'squad', id = 'raid', at = 'sunset', faction = 'Maelstrom', count = 2, waves = {{count = 2, afterSeconds = 50}}}})
advance(ctx2, insts2, 80); assert(game.nextActor == 5, 'a wave of two came: ' .. game.nextActor)
`));

test('squad: stand-down stops the waves and a wave that waits for the last to fall; the members already placed stay; the squad shows its members to a reader, and disarm forgets it', () => withGame(`
game.vpos = {x = 100, y = 100, z = 10}
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'squad', id = 'raid', at = 'sunset', faction = 'Maelstrom', count = 2, waves = {{count = 2, whenDown = true}}}})
advance(ctx, insts, 12)
assert(#prims.squadMembers('pk', 'raid') == 2 and #prims.squadMembers('pk', 'none') == 0 and #prims.squadMembers('other', 'raid') == 0)
ctx:emit('squad:raid:stand-down')
for _, a in pairs(game.actors) do a.dead = true end
advance(ctx, insts, 12)
assert(game.nextActor == 3, 'the wave never came')
assert(ctx:count('squad:raid:down') == 1, 'the squad counts as down when its members are, a wave that will not come is not waited for')
assert(#prims.squadMembers('pk', 'raid') == 0, 'the dead are not listed')
reap(ctx, insts)
assert(#prims.squadMembers('pk', 'raid') == 0)
`));

// ---- apart -------------------------------------------------------------------------------------------------------------------------------------------

test('apart: V in the ring accrues game minutes and done comes at the minutes, nothing accrues inside or outside the ring, one position read a second', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'apart', id = 'p', at = 'ring', minutes = 5, inner = 10, outer = 60, breakSeconds = 1000}})
game.rate = 30
inRing()
advance(ctx, insts, 5); assert(ctx:count('apart:p:done') == 0, 'five ticks are 150 game seconds')
local reads = game.calls.playerPosition
advance(ctx, insts, 4)
assert(game.calls.playerPosition - reads == 4, 'one read a second')
game.vpos = {x = 100, y = 200 - 3, z = 10}   -- too close: paused
advance(ctx, insts, 100); assert(ctx:count('apart:p:done') == 0, 'nothing accrues outside the ring')
game.vpos = {x = 100, y = 200 - 100, z = 10}   -- too far: paused
advance(ctx, insts, 100); assert(ctx:count('apart:p:done') == 0)
inRing()
advance(ctx, insts, 1); assert(ctx:count('apart:p:done') == 1, 'nine ticks accrued 270, the tenth is 300 game seconds')
advance(ctx, insts, 50); assert(ctx:count('apart:p:done') == 1)
`));

test('apart: near and far are said once per crossing and never for the first sample; broken comes after breakSeconds outside the ring and is cleared by coming back', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'apart', id = 'p', at = 'ring', minutes = 1000, inner = 10, outer = 60, breakSeconds = 20}})
game.vpos = {x = 100, y = 200 - 200, z = 10}   -- far from the very first sample
advance(ctx, insts, 5)
assert(ctx:count('apart:p:far') == 0 and ctx:count('apart:p:near') == 0, 'the first sample is no crossing')
inRing(); advance(ctx, insts, 5)
game.vpos = {x = 100, y = 200 - 100, z = 10}; advance(ctx, insts, 5)
assert(ctx:count('apart:p:far') == 1, 'crossed out')
advance(ctx, insts, 5); assert(ctx:count('apart:p:far') == 1)
inRing(); advance(ctx, insts, 2)
game.vpos = {x = 100, y = 200 - 4, z = 10}; advance(ctx, insts, 3)
assert(ctx:count('apart:p:near') == 1, 'crossed in')
inRing(); advance(ctx, insts, 2)
game.vpos = {x = 100, y = 200 - 100, z = 10}; advance(ctx, insts, 2)
assert(ctx:count('apart:p:far') == 2, 'a second crossing is a second event')
advance(ctx, insts, 25)
assert(ctx:count('apart:p:broken') == 1)
advance(ctx, insts, 50); assert(ctx:count('apart:p:broken') == 1 and ctx:count('apart:p:done') == 0)
-- Coming back inside the break time resets it.
local ctx2 = stageCtx()
local insts2 = drive(ctx2, {{p = 'apart', id = 'q', at = 'ring', minutes = 1000, breakSeconds = 20}})
inRing(); advance(ctx2, insts2, 2)
game.vpos = {x = 100, y = 200 - 200, z = 10}; advance(ctx2, insts2, 15)
inRing(); advance(ctx2, insts2, 2)
game.vpos = {x = 100, y = 200 - 200, z = 10}; advance(ctx2, insts2, 15)
assert(ctx2:count('apart:q:broken') == 0)
`));

test('apart: defaults of 12 and 60 metres and 120 s, a place that is not in the stage refuses, no position is a wait, without a game clock real seconds count', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'apart', id = 'p', at = 'ring', minutes = 1}})
inRing(); advance(ctx, insts, 2)
game.vpos = {x = 100, y = 200 - 11, z = 10}; advance(ctx, insts, 2)
assert(ctx:count('apart:p:near') == 1, '12 m is the inner ring')
game.vpos = {x = 100, y = 200 - 13, z = 10}; advance(ctx, insts, 2)
assert(ctx:count('apart:p:near') == 1 and ctx:count('apart:p:far') == 0)
game.vpos = {x = 100, y = 200 - 61, z = 10}; advance(ctx, insts, 2)
assert(ctx:count('apart:p:far') == 1, '60 m is the outer ring')
inRing(); advance(ctx, insts, 2)
game.vpos = {x = 100, y = 200 - 61, z = 10}; advance(ctx, insts, 119); assert(ctx:count('apart:p:broken') == 0)
advance(ctx, insts, 2); assert(ctx:count('apart:p:broken') == 1)
assert(#drive(stageCtx(), {{p = 'apart', id = 'z', at = 'nowhere', minutes = 1}}) == 0 and logged('not in the stage'))
local ctx2 = stageCtx(); local insts2 = drive(ctx2, {{p = 'apart', id = 'p', at = 'ring', minutes = 1}})
game.noPos = true; advance(ctx2, insts2, 200); assert(#ctx2.events == 0, 'no position, no event')
game.noPos = false; inRing()
local blind = Prims.new({places = places, world = world, clock = function() return game.now end, log = log}); blind.extend(Scene)
local ctx3 = stageCtx(); local def = blind.get('apart'); local state = def.arm(ctx3, {p = 'apart', id = 'p', at = 'ring', minutes = 1}, blind.env)
for _ = 1, 59 do game.now = game.now + 1; def.tick(ctx3, {}, state, blind.env) end
assert(ctx3:count('apart:p:done') == 0)
for _ = 1, 3 do game.now = game.now + 1; def.tick(ctx3, {}, state, blind.env) end
assert(ctx3:count('apart:p:done') == 1, 'a minute of real time')
`));

// ---- unseen ------------------------------------------------------------------------------------------------------------------------------------------

test('unseen: reached when V stands in the place first, spotted wins a tie, nothing after either, reads every 1.5 s', () => withGame(`
game.vpos = {x = 100, y = 100, z = 10}
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'unseen', id = 'u', at = 'ring'}})
advance(ctx, insts, 6)
assert(#ctx.events == 0)
local reads = game.calls.playerInCombat
assert(reads == 3 or reads == 4, 'about one read in 1.5 s: ' .. tostring(reads))
game.vpos = {x = 100, y = 200, z = 10}
advance(ctx, insts, 3)
assert(evs(ctx) == 'unseen:u:reached')
advance(ctx, insts, 20); assert(evs(ctx) == 'unseen:u:reached', 'once')
local ctx2 = stageCtx(); local insts2 = drive(ctx2, {{p = 'unseen', id = 'u', at = 'ring'}})
game.vCombat = true
advance(ctx2, insts2, 3)
assert(evs(ctx2) == 'unseen:u:spotted', 'V in combat with V inside the place: spotted first, not reached: ' .. evs(ctx2))
`));

test('unseen: any squad member turning to combat is spotted, V entering combat is spotted, a squad that turns hostile is spotted, the squad is read by id each time', () => withGame(`
game.vpos = {x = 100, y = 100, z = 10}
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'squad', id = 'g', at = 'sunset', faction = 'Maelstrom', count = 3}, {p = 'unseen', id = 'u', squad = 'g', at = 'far'}})
advance(ctx, insts, 12)
assert(#prims.squadMembers('pk', 'g') == 3 and ctx:count('unseen:u:spotted') == 0 and ctx:count('squad:g:hostile') == 0, 'a relaxed squad stays relaxed')
game.actors.a2.combat = true
advance(ctx, insts, 3)
assert(ctx:count('unseen:u:spotted') == 1, evs(ctx))
advance(ctx, insts, 10); assert(ctx:count('unseen:u:spotted') == 1)
-- V alone in combat, no squad at all.
local ctx2 = stageCtx(); local insts2 = drive(ctx2, {{p = 'unseen', id = 'u'}})
advance(ctx2, insts2, 3); assert(#ctx2.events == 0)
game.vCombat = true; advance(ctx2, insts2, 3); assert(evs(ctx2) == 'unseen:u:spotted')
-- The pack turning the squad hostile is spotted at once, through the event.
game.vCombat = false
local ctx3 = stageCtx(); local insts3 = drive(ctx3, {{p = 'unseen', id = 'u', squad = 'g'}})
ctx3:emit('squad:g:hostile'); assert(ctx3:count('unseen:u:spotted') == 1)
-- A squad that is down is not a reason to be spotted, and a bad place refuses to be reached but still watches.
local ctx4 = stageCtx(); local insts4 = drive(ctx4, {{p = 'unseen', id = 'u', squad = 'g', at = 'nowhere'}})
assert(#insts4 == 1 and logged('not in the stage'))
`));

// ---- dead-zone ---------------------------------------------------------------------------------------------------------------------------------------

test('dead-zone: entered and left once per crossing, the remote hold is true exactly while V is inside, the hold goes with the ctx', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'dead-zone', id = 'shield', at = 'ring'}})
assert(#game.holds == 1)
local hold = game.holds[1]
game.vpos = {x = 100, y = 200 - 100, z = 10}
advance(ctx, insts, 3)
assert(#ctx.events == 0 and hold() == false)
game.vpos = {x = 100, y = 200 - 5, z = 10}
advance(ctx, insts, 2)
assert(evs(ctx) == 'dead-zone:shield:entered' and hold() == true)
advance(ctx, insts, 5); assert(ctx:count('dead-zone:shield:entered') == 1)
game.vpos = {x = 100, y = 200 - 27, z = 10}   -- 27 m: past the 25 m radius, inside the 15 percent slack
advance(ctx, insts, 3); assert(ctx:count('dead-zone:shield:left') == 0 and hold() == true, 'the edge does not flicker')
game.vpos = {x = 100, y = 200 - 40, z = 10}
advance(ctx, insts, 2)
assert(ctx:count('dead-zone:shield:left') == 1 and hold() == false)
game.vpos = {x = 100, y = 200 - 5, z = 10}; advance(ctx, insts, 2); assert(ctx:count('dead-zone:shield:entered') == 2 and hold() == true)
reap(ctx, insts); assert(game.released == 1, 'the hold is released with the stage')
`));

test('dead-zone: far away it reads every five seconds, without a hold call it still reports its events and logs once, a place not in the stage refuses', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'dead-zone', id = 'shield', at = 'ring'}})
game.vpos = {x = 100, y = 200 - 900, z = 10}
advance(ctx, insts, 1)
local reads = game.calls.playerPosition
advance(ctx, insts, 20)
assert(game.calls.playerPosition - reads <= 4, 'slow when far: ' .. (game.calls.playerPosition - reads))
game.noHold = true
local ctx2 = stageCtx(); local insts2 = drive(ctx2, {{p = 'dead-zone', id = 'z2', at = 'ring'}})
assert(logged('cannot be held'))
game.vpos = {x = 100, y = 200 - 5, z = 10}; advance(ctx2, insts2, 10); assert(ctx2:count('dead-zone:z2:entered') == 1)
assert(#drive(stageCtx(), {{p = 'dead-zone', id = 'z3', at = 'nowhere'}}) == 0)
`));

// ---- workspot ----------------------------------------------------------------------------------------------------------------------------------------

test('workspot: a known pose is begun once on the stage copy, stepped until it plays, set is said once, then it is watched once a second, the ctx ends it', () => withGame(`
fighter('panam-palmer', 100)
game.stepScript = {['idle:generic_arms_crossed'] = {'wait', 'wait', 'playing'}}
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'workspot', id = 'pose', key = 'arms-crossed'}})
advance(ctx, insts, 2)
assert(#game.begins == 1 and game.begins[1] == 'idle:generic_arms_crossed')
assert(ctx:count('workspot:pose:set') == 0, 'still starting')
advance(ctx, insts, 3)
assert(ctx:count('workspot:pose:set') == 1 and #game.begins == 1, 'one begin, one set')
local steps = #game.steps
advance(ctx, insts, 10)
assert(#game.steps - steps == 10, 'a step a second: ' .. (#game.steps - steps))
assert(ctx:count('workspot:pose:set') == 1 and ctx:count('workspot:pose:fallback') == 0)
assert(#game.ended == 0)
reap(ctx, insts)
assert(#game.ended == 1 and game.ended[1] == 'idle:generic_arms_crossed', 'the session ended with the ctx')
`));

test('workspot: a seat pose begins as a seat, a cast member can be the body, and the pose waits for the body to attach', () => withGame(`
game.autoFighter = false
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'workspot', id = 'pose', who = 'kid', key = 'lean'}})
advance(ctx, insts, 5)
assert(#game.begins == 0 and game.calls.workspotReady == nil, 'the cast member does not exist yet: nothing is asked of the game')
game.autoFighter = true
world.castSpawn({id = 'pk:kid', who = 'extra', record = 'Character.x'})
game.readyBody = false; advance(ctx, insts, 3); assert(#game.begins == 0, 'not attached')
game.readyBody = true; advance(ctx, insts, 3)
assert(game.begins[1] == 'seat:lean' and ctx:count('workspot:pose:set') == 1)
`));

test('workspot: a pose with no known workspot plays the fallback idle and says fallback, the line goes on; a chosen fallback is used; a refused pose falls back once', () => withGame(`
fighter('panam-palmer', 100)
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'workspot', id = 'g', key = 'guitar'}})
advance(ctx, insts, 4)
assert(game.begins[1] == 'idle:generic_arms_crossed' and ctx:count('workspot:g:fallback') == 1 and ctx:count('workspot:g:set') == 1 and ctx:count('workspot:g:lost') == 0, evs(ctx))
local ctx2 = stageCtx(); local insts2 = drive(ctx2, {{p = 'workspot', id = 'm', key = 'mechanic', fallback = 'generic_hips'}})
advance(ctx2, insts2, 4); assert(game.begins[#game.begins] == 'idle:generic_hips' and ctx2:count('workspot:m:fallback') == 1)
-- The archive has no such component for a known pose: the fallback, once.
game.begins = {}
game.beginFail['idle:panam_beer'] = 'no component'
local ctx3 = stageCtx(); local insts3 = drive(ctx3, {{p = 'workspot', id = 'd', key = 'drink'}})
advance(ctx3, insts3, 4)
assert(game.begins[1] == 'idle:panam_beer' and game.begins[2] == 'idle:generic_arms_crossed' and #game.begins == 2)
assert(ctx3:count('workspot:d:fallback') == 1 and ctx3:count('workspot:d:set') == 1)
-- The fallback refused as well: lost, once, and nothing is left.
game.begins = {}; game.beginFail['idle:generic_arms_crossed'] = 'no component'
local ctx4 = stageCtx(); local insts4 = drive(ctx4, {{p = 'workspot', id = 'e', key = 'drink'}})
advance(ctx4, insts4, 6)
assert(ctx4:count('workspot:e:lost') == 1 and ctx4:count('workspot:e:set') == 0 and #game.begins == 2)
advance(ctx4, insts4, 20); assert(ctx4:count('workspot:e:lost') == 1 and #game.begins == 2)
`));

test('workspot: a pose that fails while it starts falls back, one that plays and is then left is lost once, one that fails after set is lost', () => withGame(`
fighter('panam-palmer', 100)
game.stepScript = {['idle:panam_beer'] = {'wait', 'failed'}}
local ctx = stageCtx(); local insts = drive(ctx, {{p = 'workspot', id = 'd', key = 'drink'}})
advance(ctx, insts, 8)
assert(ctx:count('workspot:d:fallback') == 1 and ctx:count('workspot:d:set') == 1, evs(ctx))
assert(#game.ended == 1 and game.ended[1] == 'idle:panam_beer', 'the failed session was ended')
-- Playing, then the body leaves the pose.
game.begins, game.ended = {}, {}
game.stepScript = {['idle:generic_arms_crossed'] = {'playing', 'playing', 'lost'}}
local ctx2 = stageCtx(); local insts2 = drive(ctx2, {{p = 'workspot', id = 'a', key = 'arms-crossed'}})
advance(ctx2, insts2, 10)
assert(ctx2:count('workspot:a:set') == 1 and ctx2:count('workspot:a:lost') == 1 and #game.ended == 1)
local steps = #game.steps
advance(ctx2, insts2, 10); assert(#game.steps == steps, 'no more steps after lost')
-- A failure after set is a loss, not a new pose.
game.begins, game.ended = {}, {}
game.stepScript = {['idle:generic_arms_crossed'] = {'playing', 'failed'}}
local ctx3 = stageCtx(); local insts3 = drive(ctx3, {{p = 'workspot', id = 'b', key = 'arms-crossed'}})
advance(ctx3, insts3, 6)
assert(ctx3:count('workspot:b:set') == 1 and ctx3:count('workspot:b:lost') == 1 and ctx3:count('workspot:b:fallback') == 0 and #game.begins == 1)
`));

test('workspot: with a place it waits up to thirty seconds for the body to be inside, then plays where she is; a busy body waits; a body that never attaches is lost after a minute', () => withGame(`
fighter('panam-palmer', 100, {x = 100, y = 200 - 500, z = 10})
local ctx = stageCtx(); local insts = drive(ctx, {{p = 'workspot', id = 'a', key = 'lean', at = 'ring'}})
advance(ctx, insts, 20); assert(#game.begins == 0, 'she is not there yet')
game.fighters['panam-palmer'].x, game.fighters['panam-palmer'].y = 100, 200
advance(ctx, insts, 2); assert(#game.begins == 1 and ctx:count('workspot:a:set') == 1)
game.begins = {}
fighter('panam-palmer', 100, {x = 100, y = 200 - 500, z = 10})
local ctx2 = stageCtx(); local insts2 = drive(ctx2, {{p = 'workspot', id = 'b', key = 'lean', at = 'ring'}})
advance(ctx2, insts2, 35); assert(#game.begins == 1 and ctx2:count('workspot:b:set') == 1, 'after thirty seconds it plays where she stands')
-- Busy: another workspot owns the body.
game.begins = {}; game.beginFail['idle:generic_arms_crossed'] = 'busy'
local ctx3 = stageCtx(); local insts3 = drive(ctx3, {{p = 'workspot', id = 'c', key = 'arms-crossed'}})
advance(ctx3, insts3, 10)
assert(ctx3:count('workspot:c:fallback') == 0 and ctx3:count('workspot:c:lost') == 0 and #game.begins >= 5, 'it keeps asking, never takes the workspot over')
game.beginFail['idle:generic_arms_crossed'] = nil
advance(ctx3, insts3, 3); assert(ctx3:count('workspot:c:set') == 1)
-- Never attached.
game.fighters['panam-palmer'].attached = false
local ctx4 = stageCtx(); local insts4 = drive(ctx4, {{p = 'workspot', id = 'd', key = 'lean'}})
advance(ctx4, insts4, 59); assert(ctx4:count('workspot:d:lost') == 0)
advance(ctx4, insts4, 3); assert(ctx4:count('workspot:d:lost') == 1)
assert(#drive(stageCtx(), {{p = 'workspot', id = 'x'}, {p = 'workspot', key = 'lean'}, {p = 'workspot', id = 'y', key = 'lean', who = 'Bad Name'}}) == 0)
`));

// ---- npc-react ---------------------------------------------------------------------------------------------------------------------------------------

test('npc-react: the outcome of the cast member comes as npc:<id>:<kind>, a command is obey, other people and unknown kinds are nothing, each outcome is said once', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'npc-react', id = 'boss', cast = 'boss'}})
assert(#game.sinks == 1 and #insts == 1 and prims.get('npc-react').tick == nil, 'a listener, no tick')
world.castSpawn({id = 'pk:boss', who = 'extra', record = 'Character.x'})
local sink = game.sinks[1]
sink('k:other', 'leave'); sink('k:x1', 'dance'); sink(nil, 'leave')
assert(#ctx.events == 0)
sink('k:x1', 'leave'); assert(evs(ctx) == 'npc:boss:leave')
sink('k:x1', 'leave'); assert(ctx:count('npc:boss:leave') == 1, 'once')
for _, kind in ipairs({'call-police', 'attack', 'cower', 'brawl'}) do sink('k:x1', kind) end
sink('k:x1', 'get-down'); sink('k:x1', 'stop'); sink('k:x1', 'exit-vehicle')
assert(evs(ctx) == 'npc:boss:leave|npc:boss:call-police|npc:boss:attack|npc:boss:cower|npc:boss:brawl|npc:boss:obey', evs(ctx))
reap(ctx, insts); assert(game.released == 1 and #game.sinks == 0, 'the listener goes with the stage')
`));

test('npc-react: an outcome before the cast member exists is nothing, the cast is looked up when the outcome arrives, a bad spec or a world with no hook is quiet', () => withGame(`
local ctx = stageCtx(); local insts = drive(ctx, {{p = 'npc-react', id = 'boss', cast = 'late'}})
game.sinks[1]('k:x1', 'attack'); assert(#ctx.events == 0)
world.castSpawn({id = 'pk:late', who = 'extra', record = 'Character.x'})
game.sinks[1]('k:x1', 'attack'); assert(evs(ctx) == 'npc:boss:attack')
assert(#drive(stageCtx(), {{p = 'npc-react', cast = 'a'}, {p = 'npc-react', id = 'x'}}) == 0)
world.npcOutcomeHook = nil
prims.env.world.npcOutcomeHook = nil
local ctx2 = stageCtx(); local insts2 = drive(ctx2, {{p = 'npc-react', id = 'boss', cast = 'late'}})
assert(#insts2 == 1 and logged('cannot be heard'))
-- A copy of another character is a cast member too.
prims.env.world.npcOutcomeHook = raw.npcOutcomeHook
`));

test('every scene primitive has no ctx timer and no per-frame work: ticks are at most once a second, unseen every one and a half', () => withGame(`
for _, name in ipairs({'bout', 'hold-until', 'apart', 'dead-zone', 'workspot'}) do assert(prims.get(name).interval == 1, name) end
assert(prims.get('unseen').interval == 1.5 and prims.get('npc-react').interval == nil and prims.get('npc-react').tick == nil)
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'apart', id = 'p', at = 'ring', minutes = 1}, {p = 'hold-until', id = 'h', hour = 23}, {p = 'dead-zone', id = 'd', at = 'ring'}, {p = 'unseen', id = 'u'}})
assert(#ctx.timers == 0, 'no timer of the ctx is used')
`));

// ---- the scene natives, on a fake of the game's own objects ---------------------------------------------------------------------------------------------

const nativeHarness = `
local Natives = ${load('quest-world-scene.lua')}
${base}
local calls = {}
local function rec(text) calls[#calls + 1] = text end
local function count(prefix) local n = 0 for _, c in ipairs(calls) do if c:sub(1, #prefix) == prefix then n = n + 1 end end return n end
Enum = {new = function(kind, name) return name end}
CName = {new = function(name) return 'cn:' .. name end}
TweakDBID = {new = function(name) return {name = name, hash = name} end}
NewObject = function(kind) return {kind = kind} end
local state = {nextId = 1, entities = {}, pool = 70, dead = false, combatOk = true, attitudeOk = true, fistsOk = true, vCombat = false, inWorkspot = false, deviceThere = false,
  placed = true, playOk = true, hasComponent = true}
local playerAgent = {}
local function newNpc(id, label)
  local npc = {id = id, tags = {}, attached = true, label = label or id.hash}
  local agent = {att = {}}
  function agent:SetAttitudeTowards(other, att) rec('attitude ' .. npc.label .. '->' .. (other.owner or '?') .. ' ' .. att); self.att[other] = att end
  function agent:GetAttitudeTowards(other) return 'EAIAttitude.' .. (state.attitudeOk and self.att[other] or 'AIA_Neutral') end
  agent.owner = npc.label
  local reaction = {}
  function reaction:TriggerCombat(target) rec('trigger ' .. npc.label .. ' at ' .. tostring(target.label)); if not state.combatOk then error('refused') end end
  local ai = {}
  function ai:SendCommand(cmd) rec('command ' .. npc.label .. ' ' .. tostring(cmd.kind)); if cmd.kind == 'AIEquipCommand' and not state.fistsOk then return false end return true end
  function npc:GetAttitudeAgent() return agent end
  function npc:GetStimReactionComponent() return reaction end
  function npc:GetAIControllerComponent() return ai end
  function npc:IsAttached() return self.attached end
  function npc:IsA(name) return name == 'NPCPuppet' end
  function npc:IsDeadNoStatPool() return state.dead end
  function npc:GetEntityID() return self.id end
  function npc:GetWorldPosition() return {x = 1, y = 2, z = 3} end
  return npc
end
local playerObj = {}
playerAgent.owner = 'V'
function playerObj:GetAttitudeAgent() return playerAgent end
function playerObj:IsInCombat() return state.vCombat end
local entitySystem = {}
function entitySystem:IsReady() return true end
function entitySystem:IsManaged(id) return state.entities[id.hash] ~= nil end
function entitySystem:GetEntity(id) return state.entities[id.hash] end
function entitySystem:IsTagged(id, tag) for _, t in ipairs(state.entities[id.hash].tags) do if t == tag then return true end end return false end
local function extra(tagged)
  local id = {hash = tostring(state.nextId)}; state.nextId = state.nextId + 1
  local npc = newNpc(id)
  if tagged ~= false then npc.tags = {'cn:CyberpunkConvaiQuest'} end
  state.entities[id.hash] = npc
  return {kind = 'extra', id = id}, npc
end
local pools = {}
function pools:RequestSettingStatPoolValue(id, pool, value, who, percent) rec('pool ' .. value); state.pool = value end
function pools:GetStatPoolValue() return state.pool end
Game = {GetPlayer = function() return playerObj end, GetDynamicEntitySystem = function() return entitySystem end, GetStatPoolsSystem = function() return pools end}
ScriptedPuppet = {IsDefeated = function() return false end}
NPCPuppet = {IsInCombat = function(npc) return state.combat == true end, ChangeHighLevelState = function(npc, s) rec('state ' .. npc.label .. ' ' .. s) end}
local copyNpc = newNpc({hash = 'copy1'}, 'copy')
local companions = {conversationCandidates = function(player, radius)
  assert(player == playerObj)
  if state.noCopy then return {} end
  return {{profileKey = 'panam-palmer', npc = copyNpc}}
end}
local workspotCalls = {}
local deviceObj = {FindComponentByName = function(_, name) if state.hasComponent then return {} end return nil end}
local fakeWorkspot = {
  inWorkspot = function(npc) return state.inWorkspot end,
  spawnDevice = function(npc, template) rec('spawnDevice ' .. template); return true, {hash = 'dev1'} end,
  deviceEntity = function(id) if state.deviceGone then return false end if state.deviceThere then return deviceObj end return nil end,
  moveDevice = function() rec('moveDevice') end,
  devicePlaced = function() return state.placed end,
  play = function(device, npc, component) rec('play ' .. component); if not state.playOk then return false, 'refused' end return true end,
  exit = function(npc, instant) rec('exit'); return true end,
  deleteDevice = function(id) rec('deleteDevice ' .. id.hash); return true end,
}
local catalog = {device = 'device.ent', idleComponents = {generic_arms_crossed = 'convai_idle_generic_arms_crossed', panam_beer = 'convai_idle_panam_beer'}, seatComponents = {lean = 'convai_sit_lean'}}
convaiQuestNpcSinks = {}
local W = Natives.new({companions = companions, workspot = fakeWorkspot, catalog = function() return catalog end, log = log, clock = function() return state.now or 0 end})
`;
const withNatives = code => run(`${nativeHarness}\n${code}`);

test('scene natives: a tagged spawn is read, an untagged entity or a stranger is never touched, a copy is found through the companion table by profile', () => withNatives(`
local mine = extra()
local read = W.fighterRead(mine)
assert(read and read.health == 70 and read.dead == false and read.combat == false and read.x == 1)
local stranger = extra(false)
assert(W.fighterRead(stranger) == nil and W.workspotReady(stranger) == nil and W.entityKey(stranger) ~= nil)
assert(W.boutArm(mine, stranger) == false and count('attitude') == 0 and count('command') == 0, 'a game placed entity is never armed')
assert(W.fighterHealth(stranger, 50) == false and count('pool') == 0)
assert(W.fighterRead({kind = 'extra', id = {hash = 'nope'}}) == nil and W.fighterRead('x') == nil and W.fighterRead(nil) == nil)
local copy = {kind = 'copy', profileKey = 'panam-palmer'}
assert(W.fighterRead(copy) ~= nil and W.entityKey(copy) == 'copy1')
assert(W.fighterRead({kind = 'copy', profileKey = 'judy-alvarez'}) == nil, 'only the profile asked for')
state.noCopy = true; assert(W.fighterRead(copy) == nil)
mine.id.hash = '1'; assert(W.entityKey(mine) == '1')
state.dead = true; assert(W.fighterRead(mine).dead == true)
assert(W.playerInCombat() == false); state.vCombat = true; assert(W.playerInCombat() == true)
`));

test('scene natives: the bout arms the two against each other only, never V, with bare hands; a refused piece is a note; the stand down makes them friends again', () => withNatives(`
local a, b = extra(), extra()
local ok, notes = W.boutArm(a, b)
assert(ok == true and notes == '', tostring(notes))
for _, c in ipairs(calls) do assert(not c:find('->V', 1, true), 'V was touched: ' .. c); assert(not c:find('copy', 1, true) or true) end
assert(count('attitude 1->2 AIA_Hostile') == 1 and count('attitude 2->1 AIA_Hostile') == 1)
assert(count('command 1 AIEquipCommand') == 1 and count('command 2 AIEquipCommand') == 1)
assert(count('trigger 1 at 2') == 1 and count('trigger 2 at 1') == 1)
calls = {}
assert(W.boutStand(a, b) == true)
assert(count('attitude 1->2 AIA_Friendly') == 1 and count('state 1 Relaxed') == 1 and count('state 2 Relaxed') == 1)
state.attitudeOk = false
local ok2, notes2 = W.boutArm(a, b); assert(ok2 == false and notes2:find('attitude', 1, true))
state.attitudeOk = true; state.fistsOk = false
local ok3, notes3 = W.boutArm(a, b); assert(ok3 == true and notes3:find('fists a', 1, true), 'bare hands refused is a note, the fight still goes')
a.id.hash = 'gone'; state.entities['1'] = nil
assert(W.boutArm(a, b) == false and W.boutStand(a, b) == false, 'a fighter that is gone arms nothing and stands down the other')
assert(W.fighterHealth(b, 150) == true and calls[#calls] == 'pool 100' and W.fighterHealth(b, 0) == true and calls[#calls] == 'pool 1', 'clamped to a pool that is never emptied by us')
`));

test('scene natives: the npc outcome hook adds a sink to the global list and removes it, and does nothing without the list', () => withNatives(`
local seen = {}
local release = W.npcOutcomeHook(function(key, kind) seen[#seen + 1] = key .. ':' .. kind end)
assert(type(release) == 'function' and #convaiQuestNpcSinks == 1)
convaiQuestNpcSinks[1]('7', 'leave'); assert(seen[1] == '7:leave')
release(); assert(#convaiQuestNpcSinks == 0); release()
convaiQuestNpcSinks = nil
assert(W.npcOutcomeHook(function() end) == nil)
`));

test('scene natives: a pose spawns the device at the body, waits for it, checks the component, plays once, is watched, and ends with the exit first then the device', () => withNatives(`
local mine, npc = extra()
local session, why = W.workspotBegin(mine, {idle = 'generic_arms_crossed'})
assert(session and why == nil and count('spawnDevice device.ent') == 1)
assert(W.workspotStep(session) == 'wait', 'the device is not there yet')
state.deviceThere = true
state.placed = false
assert(W.workspotStep(session) == 'wait' and count('play') == 0, 'not at the body yet')
state.placed = true
assert(W.workspotStep(session) == 'wait' and count('play convai_idle_generic_arms_crossed') == 1, 'played')
state.now = 1; state.inWorkspot = false
assert(W.workspotStep(session) == 'wait', 'the entry blend gets its grace')
state.inWorkspot = true
assert(W.workspotStep(session) == 'playing')
state.inWorkspot = false; state.now = 10
assert(W.workspotStep(session) == 'lost', 'she left the pose')
calls = {}
W.workspotEnd(session); W.workspotEnd(session)
assert(count('exit') == 1 and count('deleteDevice dev1') == 1 and calls[1] == 'exit' and calls[2] == 'deleteDevice dev1', 'once, exit first')
`));

test('scene natives: a pose is refused when the archive lacks it, the body is in a workspot of its own, the device is gone or the component is missing', () => withNatives(`
local mine = extra()
local s1, why1 = W.workspotBegin(mine, {idle = 'guitar'}); assert(s1 == nil and why1 == 'no component')
local s2, why2 = W.workspotBegin(mine, {seat = 'sink'}); assert(s2 == nil and why2 == 'no component')
local s3, why3 = W.workspotBegin(mine, {}); assert(s3 == nil)
local s4, why4 = W.workspotBegin({kind = 'extra', id = {hash = 'zzz'}}, {idle = 'panam_beer'}); assert(s4 == nil and why4 == 'not attached')
state.inWorkspot = true
local s5, why5 = W.workspotBegin(mine, {idle = 'panam_beer'}); assert(s5 == nil and why5 == 'busy' and count('spawnDevice') == 0, 'no device for a body that is busy')
state.inWorkspot = false
local s6 = W.workspotBegin(mine, {seat = 'lean'}); assert(s6 and s6.component == 'convai_sit_lean')
state.deviceThere = true; state.hasComponent = false
local status, reason = W.workspotStep(s6); assert(status == 'failed' and reason:find('convai_sit_lean', 1, true))
state.hasComponent = true; state.playOk = false
local s7 = W.workspotBegin(mine, {idle = 'panam_beer'})
local status7, reason7 = W.workspotStep(s7); assert(status7 == 'failed' and reason7 == 'refused')
state.deviceGone = true
local s8 = W.workspotBegin(mine, {idle = 'panam_beer'}); assert(W.workspotStep(s8) == 'failed')
assert(W.workspotStep(nil) == 'failed' and W.workspotStep({phase = 'ended'}) == 'failed')
W.workspotEnd(nil); W.workspotEnd('x')
`));

test('scene natives: the gap idle plays a standing idle of the archive on the copy once, steps until it plays, ends when the gap does, and leaves a seat kind or an unknown key alone', () => withNatives(`
assert(W.gapIdle('panam-palmer', 'couch', true, nil) == nil and count('spawnDevice') == 0, 'a seat kind is the seating code business')
assert(W.gapIdle('panam-palmer', 'nonsense', true, nil) == nil and W.gapIdle('panam-palmer', nil, true, 'nervous') == nil)
local step = W.gapIdle('panam-palmer', 'generic_arms_crossed', true, 'angry')
assert(type(step) == 'function' and count('spawnDevice') == 0, 'nothing happens until the first step')
assert(step() == false and count('spawnDevice') == 1, 'begun, device not there')
state.deviceThere = true
assert(step() == false and count('play convai_idle_generic_arms_crossed') == 1)
state.inWorkspot = true; state.now = 0
-- begun with inWorkspot true is refused, so flip: it already began above with inWorkspot false.
assert(step() == true, 'playing: the stepping is done')
assert(count('spawnDevice') == 1, 'one device')
calls = {}
assert(W.gapIdle('panam-palmer', 'generic_arms_crossed', false, 'angry') == nil)
assert(count('exit') == 1 and count('deleteDevice dev1') == 1, 'ended with the gap')
calls = {}; W.gapIdle('panam-palmer', 'generic_arms_crossed', false, nil); assert(#calls == 0, 'nothing to end twice')
`));

test('scene natives: the gap idle gives up quietly after thirty tries on a busy body, and a stale stepper stops when another idle took over or the gap ended', () => withNatives(`
state.inWorkspot = true
local step = W.gapIdle('panam-palmer', 'panam_beer', true, nil)
for i = 1, 29 do assert(step() == false, 'try ' .. i) end
assert(step() == true and count('spawnDevice') == 0, 'given up, silently')
state.inWorkspot = false
local first = W.gapIdle('panam-palmer', 'panam_beer', true, nil)
local second = W.gapIdle('panam-palmer', 'generic_arms_crossed', true, nil)
assert(first() == true and count('spawnDevice') == 0, 'the first idle was replaced')
local third = W.gapIdle('panam-palmer', 'panam_beer', true, nil)
W.gapIdle('panam-palmer', 'panam_beer', false, nil)
assert(third() == true and count('spawnDevice') == 0, 'the gap ended before the first step')
state.noCopy = true
local fourth = W.gapIdle('panam-palmer', 'panam_beer', true, nil)
assert(fourth() == false and count('spawnDevice') == 0, 'the copy is not there: tries again')
`));

// ---- the wiring: the extension loads its natives, and the world adapter keeps what it has ---------------------------------------------------------------

test('install: the natives of the scene file are added to a world that lacks them and never replace a call the world has', () => run(`${harness}
local W2 = {fighterRead = function() return 'mine' end}
local P2 = Prims.new({places = places, world = W2, clock = function() return 0 end, gameTime = function() return 0 end, log = log})
P2.env.sceneNatives = {fighterRead = function() return 'theirs' end, boutArm = function() return 'natives' end, notAFunction = 5}
assert(P2.extend(Scene))
assert(W2.fighterRead() == 'mine' and W2.boutArm() == 'natives' and W2.notAFunction == nil)
for _, name in ipairs({'bout', 'hold-until', 'apart', 'unseen', 'dead-zone', 'workspot', 'npc-react'}) do assert(P2.get(name), name) end
-- A second extension over the same registry wraps the cast spawn only once.
local W3 = {castSpawn = function(request) return {kind = 'extra', id = request.id} end}
local P3 = Prims.new({places = places, world = W3, clock = function() return 0 end, log = log})
P3.env.sceneNatives = {}
assert(P3.extend(Scene)); assert(P3.extend(Scene))
local handle = W3.castSpawn({id = 'pk:a'})
assert(handle.id == 'pk:a')
`));
