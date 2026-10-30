// The systems primitives of the bond quests, the game half (mod/quest-prims-systems.lua and mod/quest-world-systems.lua, docs/QUEST_PRIMITIVES.md section 10): pay, gift,
// garage and memory-share, the event data plumbing of mod/quest-play.lua they depend on, and the natives on a fake of the game's own objects. Run on a fake game: a clock,
// a purse, an inventory, a garage and a cast whose handles die at every tick (the test fails if a module keeps one), and a call counter on every world function.
// Nothing here starts the game.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run, load, source, base} from './quest-lua-fixture.mjs';
import {PRIMITIVES, BUILT, raisable} from './quest-primitives.mjs';

const harness = `
local Places = ${load('quest-places.lua')}
local Prims = ${load('quest-prims.lua')}
local Systems = ${load('quest-prims-systems.lua')}
local Play = ${load('quest-play.lua')}
${base}
local game = {now = 0, gameClock = 100000, tick = 0, stale = false, calls = {}, vpos = {x = 0, y = 0, z = 0}, money = 500, inv = {}, known = {}, rows = {}, rowsNil = false,
  garage = {}, garageUnreadable = false, addOk = true, addCalls = 0, casts = {}, takeFails = false, giveFails = false, countNil = false, ensured = {}, ensureOk = true,
  moneyFails = false, taken = {}, given = {}, removed = {}, files = {}, writes = 0, reads = 0, facts = {}}
local function fresh(t)
  local gen = game.tick
  return setmetatable({}, {__index = function(_, k)
    if gen ~= game.tick then game.stale = true; error('a stale handle was used: ' .. tostring(k)) end
    return t[k]
  end})
end
local raw = {
  playerPosition = function() return fresh(game.vpos) end,
  castLookup = function(handle)
    local c = game.casts[handle.id]
    if not c or not c.attached then return nil end
    return fresh({position = fresh(c.pos)})
  end,
  castIs = function(handle, entity) return handle.id == entity end,
  moneyBalance = function() return game.money end,
  moneyTake = function(amount) if game.moneyFails then return false end game.money = game.money - amount; game.taken[#game.taken + 1] = amount; return true end,
  itemExists = function(record) return game.known[record] == true end,
  itemCount = function(record) if game.countNil then return nil end return game.inv[record] or 0 end,
  itemGive = function(record, quantity) if game.giveFails then return false end game.inv[record] = (game.inv[record] or 0) + quantity; game.given[#game.given + 1] = record .. 'x' .. quantity; return true end,
  itemTake = function(record, quantity)
    if game.takeFails then return false end
    game.inv[record] = (game.inv[record] or 0) - quantity; game.removed[#game.removed + 1] = record; return true
  end,
  inventoryGifts = function(limit) if game.rowsNil then return nil end game.lastLimit = limit; return game.rows end,
  vehicleOwned = function(record) if game.garageUnreadable then return nil end return game.garage[record] == true end,
  vehicleAdd = function(record) game.addCalls = game.addCalls + 1; if not game.addOk then return false, 'refused' end game.garage[record] = true; return true end,
  tweakEnsure = function(name, basis, flats)
    game.ensured[#game.ensured + 1] = {name = name, base = basis, flats = flats}
    if not game.ensureOk then return false, 'no base' end
    game.known[name] = true
    return true
  end,
}
local world = {}
for name, fn in pairs(raw) do
  world[name] = function(...) game.calls[name] = (game.calls[name] or 0) + 1; return fn(...) end
end
local clock = function() return game.now end
local places = Places.new({world = world, clock = clock, log = log})
local function newPrims()
  local p = Prims.new({places = places, world = world, clock = clock, gameTime = function() return game.gameClock end, log = log})
  p.env.systemsNatives = {}
  assert(p.extend(Systems))
  return p
end
local prims = newPrims()
-- A stage ctx like the real one: tracks and reaps LIFO, offers listeners with the event data, runs its timers when the clock reaches them, keeps its primitive instances.
local function stageCtx(pack, serial)
  local ctx = {pack = pack or 'pk', character = 'panam-palmer', serial = serial or 1, tracked = {}, events = {}, data = {}, listeners = {}, timers = {}, prims = {}, reaped = false,
    gifts = {loved = {{prefix = 'Items.Nomad_'}}, liked = {{id = 'Items.Beer'}}, disliked = {{contains = 'Cop_'}}}}
  function ctx:track(kind, handle, undo) self.tracked[#self.tracked + 1] = {kind = kind, handle = handle, undo = undo}; return handle end
  function ctx:on(name, fn) self.listeners[#self.listeners + 1] = {name = name, fn = fn}; return fn end
  function ctx:after(seconds, fn, opts) self.timers[#self.timers + 1] = {at = game.now + seconds, fn = fn, opts = opts} end
  function ctx:emit(name, data)
    if self.reaped then return end
    self.events[#self.events + 1] = name
    self.data[#self.events] = data
    local snapshot = {}
    for i, l in ipairs(self.listeners) do snapshot[i] = l end
    for _, l in ipairs(snapshot) do if l.name == name and not self.reaped then l.fn(name, data) end end
  end
  function ctx:reap()
    self.reaped = true
    self.timers, self.listeners = {}, {}
    for i = #self.prims, 1, -1 do local inst = self.prims[i]; if inst.def.disarm then inst.def.disarm(self, inst.spec, inst.state, prims.env) end end
    for i = #self.tracked, 1, -1 do local t = self.tracked[i]; self.tracked[i] = nil; if t.undo then t.undo(t.handle) end end
  end
  function ctx:count(name) local n = 0 for _, e in ipairs(self.events) do if e == name then n = n + 1 end end return n end
  function ctx:last(name) for i = #self.events, 1, -1 do if self.events[i] == name then return self.data[i] end end return nil end
  return ctx
end
local function arm(ctx, spec)
  local def = prims.get(spec.p)
  assert(def, 'no primitive ' .. tostring(spec.p))
  local state = def.arm(ctx, spec, prims.env)
  if state ~= nil then ctx.prims[#ctx.prims + 1] = {name = spec.p, def = def, spec = spec, state = state} end
  return state
end
-- A cast member of the stage, as the cast primitive leaves it: an instance with its id and a plain handle.
local function castMember(ctx, id, x, y, z, attached)
  game.casts[id .. '#h'] = {attached = attached ~= false, pos = {x = x or 0, y = y or 0, z = z or 0}}
  ctx.prims[#ctx.prims + 1] = {name = 'cast', def = prims.get('cast'), spec = {}, state = {id = id, handle = {kind = 'extra', id = id .. '#h'}}}
end
local function advance(ctx, seconds)
  for _ = 1, seconds do
    game.now = game.now + 1; game.gameClock = game.gameClock + 1; game.tick = game.tick + 1
    for i = #ctx.timers, 1, -1 do
      local t = ctx.timers[i]
      if t and game.now >= t.at then table.remove(ctx.timers, i); t.fn() end
    end
  end
end
local function evs(ctx) return table.concat(ctx.events, '|') end
local function offer(ctx, name, data) ctx:emit(name, data) end
`;
const withGame = code => run(`${harness}\n${code}\nassert(not game.stale, 'a handle was kept across ticks')`);

// ---- the registry agrees -------------------------------------------------------------------------------------------------------------------------------------

test('registry: the four systems primitives exist in the registry, are played, and the events of the file are the registry events', () => {
  for (const name of ['pay', 'gift', 'garage', 'memory-share']) {
    assert.ok(PRIMITIVES[name], name);
    assert.ok(BUILT.has(name), name);
  }
  assert.ok(raisable('pay:toll:paid', [{p: 'pay', id: 'toll', to: 'guard', amount: 100}]));
  assert.ok(raisable('pay:toll:short', [{p: 'pay', id: 'toll', to: 'guard', amount: 100}]));
  assert.ok(raisable('pay:toll:broke', [{p: 'pay', id: 'toll', to: 'guard', amount: 100}]));
  assert.ok(raisable('gift:g:second', [{p: 'gift', id: 'g', dir: 'receive'}]));
  assert.ok(raisable('gift:g:disliked', [{p: 'gift', id: 'g', dir: 'give'}]));
  assert.ok(raisable('garage:g:owned', [{p: 'garage', id: 'g', vehicle: 'Vehicle.x'}]));
  assert.ok(raisable('memory-share:m:done', [{p: 'memory-share', id: 'm', to: 'kerry-eurodyne'}]));
  assert.deepEqual(PRIMITIVES.pay.listens, ['pay:<id>:offer']);
  assert.deepEqual(PRIMITIVES.gift.listens, ['gift:<id>:offer']);
});

test('none of the four ticks: they act on an event or on one timer, so nothing runs per frame', () => withGame(`
for _, name in ipairs({'pay', 'gift', 'garage', 'memory-share'}) do
  local def = prims.get(name)
  assert(def and def.arm and def.tick == nil and def.interval == nil, name .. ' must not tick')
end
`));

// ---- words and rules -------------------------------------------------------------------------------------------------------------------------------------------

test('words and match: lowercase words without stop words, plural s dropped, most words win, then the larger share, ties to the first', () => withGame(`
local w = table.concat(Systems.words('Here is a Cheap BEER for you, boss!'), ',')
assert(w == 'cheap,beer,bos', w)
local joined = table.concat(Systems.words('I got you something: the Nomad Jackets'), ',')
assert(joined == 'nomad,jacket', joined)
local rows = {{record = 'Items.Beer_A', name = 'Beer'}, {record = 'Items.Beer_B', name = 'Cheap Beer'}, {record = 'Items.Water', name = 'Water'}}
assert(Systems.match('a cheap beer', rows).record == 'Items.Beer_B', 'two words beat one')
assert(Systems.match('some beer', rows).record == 'Items.Beer_A', 'the larger share of the name wins the tie')
local twins = {{record = 'Items.First', name = 'Old Whiskey'}, {record = 'Items.Second', name = 'Old Whiskey'}}
assert(Systems.match('whiskey', twins).record == 'Items.First', 'the first of equals')
assert(Systems.match('nothing here that matches', rows) == nil)
-- A name that is unreadable falls back to the words of the record id.
assert(Systems.match('the nomad jacket', {{record = 'Items.Nomad_Jacket'}}).record == 'Items.Nomad_Jacket')
-- Other scripts are words too.
assert(Systems.match('tengo cerveza', {{record = 'Items.Beer', name = 'cerveza fria'}}).record == 'Items.Beer')
`));

test('classify: loved, liked, disliked in that order by id, prefix or contains (lowercase), neutral otherwise', () => withGame(`
local rules = {loved = {{prefix = 'Items.Nomad_'}, {id = 'Items.Special'}}, liked = {{contains = 'beer'}}, disliked = {{contains = 'Cop_'}, {prefix = 'Items.Nomad_Bad'}}}
assert(Systems.classify(rules, 'Items.Nomad_Jacket') == 'loved')
assert(Systems.classify(rules, 'items.special') == 'loved')
assert(Systems.classify(rules, 'Items.Cheap_Beer') == 'liked')
assert(Systems.classify(rules, 'Items.Cop_Hat') == 'disliked')
assert(Systems.classify(rules, 'Items.Nomad_Bad_Jacket') == 'loved', 'loved is looked at first')
assert(Systems.classify(rules, 'Items.Water') == 'neutral')
assert(Systems.classify(nil, 'Items.Water') == 'neutral' and Systems.classify({loved = 5}, 'Items.Water') == 'neutral')
`));

// ---- pay ---------------------------------------------------------------------------------------------------------------------------------------------------------------

const payStage = (extra = '') => `
local ctx = stageCtx('pk', 1)
castMember(ctx, 'guard', 3, 4, 0)
arm(ctx, {p = 'pay', id = 'toll', to = 'guard', amount = 100${extra}})
`;

test('pay: an offer of enough, with V by the cast member and the money in the purse, takes the money and says paid with the amount; it resolves once', () => withGame(`${payStage()}
offer(ctx, 'pay:toll:offer', {amount = 100})
assert(evs(ctx):find('pay:toll:paid', 1, true) and ctx:last('pay:toll:paid').amount == 100, evs(ctx))
assert(game.money == 400 and #game.taken == 1)
offer(ctx, 'pay:toll:offer', {amount = 100})
assert(ctx:count('pay:toll:paid') == 1 and game.money == 400, 'resolved once')
assert(#game.given == 0 and #game.removed == 0, 'the cast member is given nothing physical')
`));

test('pay: V is not charged more than the asking price, and a haggle at or above min is paid at the offer', () => withGame(`${payStage(', min = 60')}
offer(ctx, 'pay:toll:offer', {amount = 80})
assert(ctx:last('pay:toll:paid').amount == 80 and game.money == 420, 'a haggle pays the offer')
local ctx2 = stageCtx('pk2', 1)
castMember(ctx2, 'guard', 3, 4, 0)
arm(ctx2, {p = 'pay', id = 'toll', to = 'guard', amount = 100, min = 60})
offer(ctx2, 'pay:toll:offer', {amount = 500})
assert(ctx2:last('pay:toll:paid').amount == 100 and game.money == 320, 'never more than the asking price')
local ctx3 = stageCtx('pk3', 1)
castMember(ctx3, 'guard', 3, 4, 0)
arm(ctx3, {p = 'pay', id = 'toll', to = 'guard', amount = 100})
offer(ctx3, 'pay:toll:offer', {amount = 99})
assert(ctx3:count('pay:toll:short') == 1, 'without a min the asking price is the least')
`));

test('pay: less than min is short and takes nothing, short and broke may repeat, and a good offer afterwards still pays', () => withGame(`${payStage(', min = 60')}
offer(ctx, 'pay:toll:offer', {amount = 40}); offer(ctx, 'pay:toll:offer', {amount = 59})
assert(ctx:count('pay:toll:short') == 2 and ctx:last('pay:toll:short').amount == 59 and game.money == 500 and #game.taken == 0, evs(ctx))
game.money = 30
offer(ctx, 'pay:toll:offer', {amount = 100}); offer(ctx, 'pay:toll:offer', {amount = 70})
assert(ctx:count('pay:toll:broke') == 2 and game.money == 30 and #game.taken == 0, 'broke takes nothing: ' .. evs(ctx))
game.money = 300
offer(ctx, 'pay:toll:offer', {amount = 100})
assert(ctx:count('pay:toll:paid') == 1 and game.money == 200)
assert(ctx:count('pay:toll:short') == 2 and ctx:count('pay:toll:broke') == 2)
`));

test('pay: a purse that fails the removal is broke, an unreadable balance, an offer without a number and a V who is far from the cast member do nothing', () => withGame(`${payStage()}
game.moneyFails = true
offer(ctx, 'pay:toll:offer', {amount = 100})
assert(ctx:count('pay:toll:broke') == 1 and ctx:count('pay:toll:paid') == 0 and game.money == 500)
game.moneyFails = false
offer(ctx, 'pay:toll:offer', nil); offer(ctx, 'pay:toll:offer', {amount = 'lots'}); offer(ctx, 'pay:toll:offer', {amount = 0 / 0})
assert(ctx:count('pay:toll:broke') == 1 and ctx:count('pay:toll:short') == 0 and ctx:count('pay:toll:paid') == 0, 'no amount: nothing is answered: ' .. evs(ctx))
game.vpos = {x = 40, y = 0, z = 0}
offer(ctx, 'pay:toll:offer', {amount = 100})
assert(ctx:count('pay:toll:paid') == 0 and game.money == 500, 'V is 37 m away')
game.vpos = {x = 3, y = 4, z = 30}
offer(ctx, 'pay:toll:offer', {amount = 100})
assert(ctx:count('pay:toll:paid') == 0, 'V is on another floor')
game.vpos = {x = 0, y = 0, z = 0}
game.casts['guard#h'].attached = false
offer(ctx, 'pay:toll:offer', {amount = 100})
assert(ctx:count('pay:toll:paid') == 0, 'the cast member is not attached')
game.casts['guard#h'].attached = true
local before = game.calls.moneyBalance
offer(ctx, 'pay:toll:offer', {amount = 100})
assert(ctx:count('pay:toll:paid') == 1 and game.calls.moneyBalance == before + 1, 'one balance read for the payment')
`));

test('pay: pay:<id>:declined is a recognised event that changes nothing, a stage with a cast it cannot find ignores offers, and bad specs do not arm', () => withGame(`${payStage()}
offer(ctx, 'pay:toll:declined')
offer(ctx, 'pay:toll:offer', {amount = 100})
assert(ctx:count('pay:toll:paid') == 1, 'declined is not terminal')
local lost = stageCtx('lost', 1)
arm(lost, {p = 'pay', id = 'toll', to = 'nobody', amount = 100})
offer(lost, 'pay:toll:offer', {amount = 100})
assert(#lost.events == 1 and game.money == 400, 'no such cast member: ' .. evs(lost))
for _, spec in ipairs({{p = 'pay', id = 'x'}, {p = 'pay', id = 'x', to = 'g'}, {p = 'pay', id = 'x', to = 'g', amount = 0}, {p = 'pay', id = 'x', to = 'g', amount = 1.5}, {p = 'pay', to = 'g', amount = 5}}) do
  assert(arm(stageCtx('bad'), spec) == nil)
end
`));

test('pay: payTargets lists the waiting stages, drops a paid one, a reaped one and a forgotten one; payTargetFor names the stage of a cast member and is a nil check with none', () => withGame(`
assert(prims.payTargets and #prims.payTargets() == 0)
local calls = game.calls.castIs or 0
assert(prims.payTargetFor('guard#h', nil) == nil and (game.calls.castIs or 0) == calls, 'nothing armed: no native call')
local a, b = stageCtx('alpha', 1), stageCtx('beta', 2)
castMember(a, 'guard', 100, 100, 0); castMember(b, 'clerk', 2, 2, 0)
arm(a, {p = 'pay', id = 'toll', to = 'guard', amount = 100})
arm(b, {p = 'pay', id = 'tab', to = 'clerk', amount = 50})
local t = prims.payTargets()
assert(#t == 2 and t[1].pack == 'alpha' and t[1].cast == 'guard' and t[2].pack == 'beta' and t[2].cast == 'clerk')
local hit = prims.payTargetFor('clerk#h', 'someone')
assert(hit and hit.pack == 'beta' and hit.cast == 'clerk')
assert(prims.payTargetFor('stranger#h', nil) == nil)
offer(a, 'pay:toll:offer', {amount = 100}); assert(a:count('pay:toll:paid') == 0, 'V is by the clerk, not by the guard')
game.vpos = {x = 100, y = 100, z = 0}
offer(a, 'pay:toll:offer', {amount = 100}); assert(a:count('pay:toll:paid') == 1)
t = prims.payTargets(); assert(#t == 1 and t[1].pack == 'beta', 'paid stages drop out')
assert(prims.payTargetFor('guard#h', nil) == nil, 'and so does their cast member')
b:reap(); assert(#prims.payTargets() == 0, 'a reaped stage drops out')
local c = stageCtx('gamma', 3)
castMember(c, 'guard', 1, 1, 0)
arm(c, {p = 'pay', id = 'toll', to = 'guard', amount = 100})
assert(#prims.payTargets() == 1)
c.reaped = true   -- a world change forgets a ctx without undo
assert(#prims.payTargets() == 0, 'a forgotten stage drops out')
local left = 0 for _ in pairs(prims.payRegistry) do left = left + 1 end
assert(left == 1, 'and its entry is pruned (only the paid stage of alpha is still held): ' .. left)
`));

// ---- gift: receive -------------------------------------------------------------------------------------------------------------------------------------------------

const receive = (fields = '') => `
game.known['Items.Gun'] = true; game.known['Items.Cash'] = true
local ctx = stageCtx('pk', 4)
arm(ctx, {p = 'gift', id = 'g', dir = 'receive', item = 'Items.Gun', second = 'Items.Cash'${fields}})
`;

test('gift receive: one second after arm V gets the item, the event carries the record, and it happens once', () => withGame(`${receive()}
advance(ctx, 0); assert(#ctx.events == 0 and #game.given == 0, 'not at arm')
advance(ctx, 1)
assert(evs(ctx) == 'gift:g:given' and ctx:last('gift:g:given').item == 'Items.Gun', evs(ctx))
assert(game.inv['Items.Gun'] == 1 and #game.given == 1 and game.given[1] == 'Items.Gunx1')
advance(ctx, 30); ctx:emit('gift:g:go')
assert(#game.given == 1 and ctx:count('gift:g:given') == 1, 'once per stage')
`));

test('gift receive: V who has the first gets the second and the event says second; with no second named the first is given again; quantity is honoured', () => withGame(`${receive()}
game.inv['Items.Gun'] = 1
advance(ctx, 1)
assert(evs(ctx) == 'gift:g:second' and ctx:last('gift:g:second').item == 'Items.Cash' and game.inv['Items.Cash'] == 1, evs(ctx))
local c2 = stageCtx('pk2', 1)
arm(c2, {p = 'gift', id = 'g', dir = 'receive', item = 'Items.Gun', quantity = 3})
advance(c2, 1)
assert(evs(c2) == 'gift:g:given' and game.inv['Items.Gun'] == 4, evs(c2))
`));

test('gift receive: a missing record, an unreadable inventory, a refused give and a missing second all say failed; a listed go event starts it at once', () => withGame(`
local ctx = stageCtx('a', 1)
arm(ctx, {p = 'gift', id = 'g', dir = 'receive', item = 'Items.Nothing'})
advance(ctx, 1); assert(evs(ctx) == 'gift:g:failed' and ctx:last('gift:g:failed').item == 'Items.Nothing' and #game.given == 0, evs(ctx))
game.known['Items.Gun'] = true
local c2 = stageCtx('b', 1)
arm(c2, {p = 'gift', id = 'g', dir = 'receive', item = 'Items.Gun'})
game.countNil = true; advance(c2, 1); assert(evs(c2) == 'gift:g:failed', evs(c2)); game.countNil = false
local c3 = stageCtx('c', 1)
arm(c3, {p = 'gift', id = 'g', dir = 'receive', item = 'Items.Gun'})
game.giveFails = true; advance(c3, 1); assert(evs(c3) == 'gift:g:failed' and game.inv['Items.Gun'] == nil, evs(c3)); game.giveFails = false
game.inv['Items.Gun'] = 1
local c4 = stageCtx('d', 1)
arm(c4, {p = 'gift', id = 'g', dir = 'receive', item = 'Items.Gun', second = 'Items.Gone'})
advance(c4, 1); assert(evs(c4) == 'gift:g:failed' and c4:last('gift:g:failed').item == 'Items.Gone', evs(c4))
local c5 = stageCtx('e', 1)
arm(c5, {p = 'gift', id = 'g', dir = 'receive', item = 'Items.Gun2'})
game.known['Items.Gun2'] = true
c5:emit('gift:g:go'); assert(c5:count('gift:g:given') == 1, evs(c5))
advance(c5, 3); assert(c5:count('gift:g:given') == 1)
for _, spec in ipairs({{p = 'gift', id = 'x'}, {p = 'gift', id = 'x', dir = 'receive'}, {p = 'gift', id = 'x', dir = 'sideways', item = 'Items.A'}, {p = 'gift', dir = 'receive', item = 'Items.A'}}) do
  assert(arm(stageCtx('bad'), spec) == nil)
end
`));

test('gift receive: a custom record is made first from the spec (tweak or tweakSpecs), and one that cannot be made fails the gift', () => withGame(`
local ctx = stageCtx('kerry', 2)
local flats = {{'displayName', 'Guinevere'}}
arm(ctx, {p = 'gift', id = 'g', dir = 'receive', item = 'Items.QuestGuinevere', tweak = {base = 'Items.Base_Gun', flats = flats}})
assert(game.known['Items.QuestGuinevere'] == nil, 'not yet')
advance(ctx, 1)
assert(#game.ensured == 1 and game.ensured[1].name == 'Items.QuestGuinevere' and game.ensured[1].base == 'Items.Base_Gun' and game.ensured[1].flats == flats)
assert(evs(ctx) == 'gift:g:given' and game.inv['Items.QuestGuinevere'] == 1, evs(ctx))
local c2 = stageCtx('kerry2', 2)
arm(c2, {p = 'gift', id = 'g', dir = 'receive', item = 'Items.QuestA', tweakSpecs = {{name = 'Items.QuestA', base = 'Items.B', flats = {}}, {name = 'Items.QuestB', base = 'Items.B', flats = {}}}})
advance(c2, 1)
assert(#game.ensured == 3 and game.ensured[3].name == 'Items.QuestB' and evs(c2) == 'gift:g:given')
game.ensureOk = false
local c3 = stageCtx('kerry3', 2)
arm(c3, {p = 'gift', id = 'g', dir = 'receive', item = 'Items.QuestC', tweak = {base = 'Items.B', flats = {}}})
advance(c3, 1)
assert(evs(c3) == 'gift:g:failed' and game.inv['Items.QuestC'] == nil, evs(c3))
`));

test('gift receive: a stage that arms again in the same session does not give again, unless the game clock went back (an earlier save was loaded)', () => withGame(`${receive()}
advance(ctx, 1); assert(evs(ctx) == 'gift:g:given')
local again = stageCtx('pk', 4)
arm(again, {p = 'gift', id = 'g', dir = 'receive', item = 'Items.Gun', second = 'Items.Cash'})
advance(again, 5)
assert(#again.events == 0 and #game.given == 1, 'same pack, serial and id: given once: ' .. evs(again))
local next_ = stageCtx('pk', 5)
arm(next_, {p = 'gift', id = 'g', dir = 'receive', item = 'Items.Gun', second = 'Items.Cash'})
advance(next_, 1); assert(evs(next_) == 'gift:g:second', 'a later stage visit is a new gift')
game.inv['Items.Gun'] = nil; game.inv['Items.Cash'] = nil
game.gameClock = 100
local loaded = stageCtx('pk', 4)
arm(loaded, {p = 'gift', id = 'g', dir = 'receive', item = 'Items.Gun', second = 'Items.Cash'})
advance(loaded, 1); assert(evs(loaded) == 'gift:g:given', 'the game went back: ' .. evs(loaded))
`));

// ---- gift: give ------------------------------------------------------------------------------------------------------------------------------------------------------

const give = `
game.inv = {['Items.Nomad_Jacket'] = 1, ['Items.Beer'] = 2, ['Items.Cop_Hat'] = 1, ['Items.Water'] = 3}
game.rows = {
  {record = 'Items.Water', name = 'Bottled Water', kind = 'Consumable', quantity = 3},
  {record = 'Items.Beer', name = 'Cheap Beer', kind = 'Consumable', quantity = 2},
  {record = 'Items.Nomad_Jacket', name = 'Nomad Jacket', kind = 'Clothing', quantity = 1},
  {record = 'Items.Cop_Hat', name = 'Police Hat', kind = 'Clothing', quantity = 1},
}
local ctx = stageCtx('pk', 1)
arm(ctx, {p = 'gift', id = 'g', dir = 'give'})
`;

test('gift give: each tier by the stage rules, the event carries the record, one is taken, and V can give again', () => withGame(`${give}
offer(ctx, 'gift:g:offer', {words = 'here, I got you this nomad jacket'})
assert(ctx:count('gift:g:loved') == 1 and ctx:last('gift:g:loved').item == 'Items.Nomad_Jacket' and game.inv['Items.Nomad_Jacket'] == 0 and game.removed[1] == 'Items.Nomad_Jacket', evs(ctx))
offer(ctx, 'gift:g:offer', {words = 'a cheap beer for you'})
assert(ctx:count('gift:g:liked') == 1 and ctx:last('gift:g:liked').item == 'Items.Beer' and game.inv['Items.Beer'] == 1)
offer(ctx, 'gift:g:offer', {words = 'take this bottled water'})
assert(ctx:count('gift:g:neutral') == 1 and ctx:last('gift:g:neutral').item == 'Items.Water' and game.inv['Items.Water'] == 2)
offer(ctx, 'gift:g:offer', {words = 'police hat, for you'})
assert(ctx:count('gift:g:disliked') == 1 and ctx:last('gift:g:disliked').item == 'Items.Cop_Hat')
assert(#game.removed == 4, 'one item each, quantity 1')
assert(game.lastLimit == 200, 'one bounded inventory read: ' .. tostring(game.lastLimit))
`));

test('gift give: nothing matches, an empty or unreadable inventory, an item V no longer has and a refused take all say nothing and take nothing', () => withGame(`${give}
offer(ctx, 'gift:g:offer', {words = 'I got you something nice'})
assert(ctx:count('gift:g:nothing') == 1 and #game.removed == 0, evs(ctx))
offer(ctx, 'gift:g:offer', nil)
assert(ctx:count('gift:g:nothing') == 2, 'no words')
game.inv['Items.Beer'] = 0
offer(ctx, 'gift:g:offer', {words = 'a cheap beer'})
assert(ctx:count('gift:g:nothing') == 3 and #game.removed == 0, 'the row said two, the read says none: ' .. evs(ctx))
game.takeFails = true
offer(ctx, 'gift:g:offer', {words = 'bottled water'})
assert(ctx:count('gift:g:nothing') == 4 and game.inv['Items.Water'] == 3, 'a refused take: ' .. evs(ctx)); game.takeFails = false
game.rowsNil = true
offer(ctx, 'gift:g:offer', {words = 'bottled water'}); assert(ctx:count('gift:g:nothing') == 5)
game.rowsNil = false; game.rows = {}
offer(ctx, 'gift:g:offer', {words = 'bottled water'}); assert(ctx:count('gift:g:nothing') == 6)
game.rows = {{record = 'Items.Water', name = 'Bottled Water'}}
game.countNil = true
offer(ctx, 'gift:g:offer', {words = 'bottled water'}); assert(ctx:count('gift:g:nothing') == 7 and #game.removed == 0)
`));

test('gift give: the rows are bounded at 200 and the number of offers is bounded', () => withGame(`
game.rows = {}
for i = 1, 300 do game.rows[i] = {record = 'Items.Thing' .. string.rep('x', 0) .. i, name = 'Gadget' .. string.char(96 + (i % 26) + 1) .. 'q'} end
game.rows[250] = {record = 'Items.Late', name = 'Zebra Statue'}
game.inv['Items.Late'] = 1
local ctx = stageCtx('pk', 1)
arm(ctx, {p = 'gift', id = 'g', dir = 'give'})
offer(ctx, 'gift:g:offer', {words = 'the zebra statue'})
assert(ctx:count('gift:g:nothing') == 1, 'a row past 200 is not looked at')
for _ = 1, 20 do offer(ctx, 'gift:g:offer', {words = 'zebra'}) end
assert(ctx:count('gift:g:nothing') == 10, 'at most ten offers are answered: ' .. ctx:count('gift:g:nothing'))
`));

// ---- garage ----------------------------------------------------------------------------------------------------------------------------------------------------------

test('garage: the unlock is called when V does not have the vehicle, and the event says added with the record', () => withGame(`
local ctx = stageCtx('kerry', 1)
arm(ctx, {p = 'garage', id = 'g', vehicle = 'Vehicle.v_guinevere'})
advance(ctx, 0); assert(game.addCalls == 0, 'not at arm')
advance(ctx, 1)
assert(evs(ctx) == 'garage:g:added' and ctx:last('garage:g:added').vehicle == 'Vehicle.v_guinevere' and game.addCalls == 1 and game.garage['Vehicle.v_guinevere'], evs(ctx))
advance(ctx, 30); assert(game.addCalls == 1 and #ctx.events == 1, 'once')
`));

test('garage: a vehicle V already has is owned and the unlock is not called; a refused unlock, or one that did not stick, is failed; an unreadable list adds anyway', () => withGame(`
game.garage['Vehicle.v_old'] = true
local ctx = stageCtx('a', 1)
arm(ctx, {p = 'garage', id = 'g', vehicle = 'Vehicle.v_old'})
advance(ctx, 1); assert(evs(ctx) == 'garage:g:owned' and game.addCalls == 0, evs(ctx))
game.addOk = false
local c2 = stageCtx('b', 1)
arm(c2, {p = 'garage', id = 'g', vehicle = 'Vehicle.v_new'})
advance(c2, 1); assert(evs(c2) == 'garage:g:failed' and game.addCalls == 1 and not game.garage['Vehicle.v_new'], evs(c2))
game.addOk = true
local c3 = stageCtx('c', 1)
arm(c3, {p = 'garage', id = 'g', vehicle = 'Vehicle.v_odd'})
game.garageUnreadable = true
advance(c3, 1); assert(evs(c3) == 'garage:g:added' and game.addCalls == 2, 'unreadable list: ' .. evs(c3))
game.garageUnreadable = false
for _, spec in ipairs({{p = 'garage', id = 'x'}, {p = 'garage', vehicle = 'Vehicle.a'}, {p = 'garage', id = 'x', vehicle = 'no spaces allowed'}}) do assert(arm(stageCtx('bad'), spec) == nil) end
`));

test('garage: arming again in the same session says added again (idempotent, no second unlock), a restart says owned, a game clock that went back adds again', () => withGame(`
local ctx = stageCtx('kerry', 1)
arm(ctx, {p = 'garage', id = 'g', vehicle = 'Vehicle.v_guinevere'})
advance(ctx, 1); assert(evs(ctx) == 'garage:g:added' and game.addCalls == 1)
local again = stageCtx('kerry', 1)
arm(again, {p = 'garage', id = 'g', vehicle = 'Vehicle.v_guinevere'})
advance(again, 1); assert(evs(again) == 'garage:g:added' and game.addCalls == 1, 'the same answer, no second call: ' .. evs(again))
game.gameClock = 10   -- an earlier save was loaded: the memory of the session is forgotten, the garage keeps the car
local loadedBack = stageCtx('kerry', 1)
arm(loadedBack, {p = 'garage', id = 'g', vehicle = 'Vehicle.v_guinevere'})
advance(loadedBack, 1); assert(evs(loadedBack) == 'garage:g:owned', evs(loadedBack))
prims = newPrims()   -- the game was restarted: the session memory is gone, the garage keeps the car
local restarted = stageCtx('kerry', 1)
arm(restarted, {p = 'garage', id = 'g', vehicle = 'Vehicle.v_guinevere'})
advance(restarted, 1); assert(evs(restarted) == 'garage:g:owned' and game.addCalls == 1, evs(restarted))
`));

// ---- memory-share ----------------------------------------------------------------------------------------------------------------------------------------------------

test('memory-share: raises done at the next step and only once; a spec without an id does not arm', () => withGame(`
local ctx = stageCtx('pk', 1)
arm(ctx, {p = 'memory-share', id = 'm', to = 'kerry-eurodyne'})
assert(#ctx.events == 0, 'after stage:enter, not inside arm')
advance(ctx, 1); advance(ctx, 20)
assert(evs(ctx) == 'memory-share:m:done')
assert(arm(stageCtx('bad'), {p = 'memory-share', to = 'x'}) == nil)
`));

// ---- cleanup -----------------------------------------------------------------------------------------------------------------------------------------------------------

test('cleanup: a reaped stage runs no timer and answers no offer; nothing of the four holds a native handle or leaves a tracked item', () => withGame(`
local ctx = stageCtx('pk', 1)
castMember(ctx, 'guard', 1, 1, 0)
arm(ctx, {p = 'pay', id = 'toll', to = 'guard', amount = 100})
arm(ctx, {p = 'gift', id = 'g', dir = 'receive', item = 'Items.Gun'})
arm(ctx, {p = 'garage', id = 'v', vehicle = 'Vehicle.v_x'})
arm(ctx, {p = 'memory-share', id = 'm', to = 'x'})
game.known['Items.Gun'] = true
ctx:reap()
advance(ctx, 10)
ctx:emit('pay:toll:offer', {amount = 100}); ctx:emit('gift:g:go')
assert(#ctx.events == 0 and game.addCalls == 0 and #game.given == 0 and game.money == 500, 'nothing happens after the reap')
assert(#ctx.tracked == 0 and #prims.payTargets() == 0 and next(prims.payRegistry) == nil)
-- A stage reaped before its timers: no event, no call.
local early = stageCtx('early', 1)
arm(early, {p = 'garage', id = 'v', vehicle = 'Vehicle.v_x'})
early:reap(); advance(early, 5); assert(#early.events == 0 and game.addCalls == 0)
`));

test('the three files are plain Lua with no semicolon or dash in a comment, no per-frame hook, no other mod named, and the world file keeps the unverified list', () => {
  for (const name of ['quest-prims-systems.lua', 'quest-world-systems.lua', 'quest-facts.lua']) {
    const text = source(name);
    assert.ok(!/\bgoto\b|table\.unpack|bit32|\/\/|~=\s*nil\s*\?/.test(text.replace(/--.*$/gm, '')), `${name}: a newer Lua form`);
    for (const line of text.split('\n')) {
      const at = line.indexOf('--');
      if (at >= 0) {
        const comment = line.slice(at + 2);
        assert.ok(!comment.includes(';') && !/(^|[^-])--([^-]|$)/.test(comment), `${name}: no semicolon or double hyphen in a comment: ${line}`);
      }
      assert.ok(!new RegExp(String.fromCharCode(91, 0x2013, 0x2014, 93)).test(line), `${name}: no en or em dash: ${line}`);
    }
    assert.ok(!/\bAMM\b|reference-amm|Night City Allies|codeware|TweakXL/i.test(text), `${name}: names another mod`);
    assert.ok(!/onUpdate|GameSession|\bonDraw\b/.test(text), `${name}: no per-frame hook`);
    assert.ok(!/_G\b/.test(text.replace(/--.*$/gm, '')) || name === 'quest-world-systems.lua', `${name}: no global table`);
  }
  assert.match(source('quest-world-systems.lua'), /UNVERIFIED in the game/);
  assert.match(source('quest-world-systems.lua'), /IT CHANGES THE SAVE/);
  assert.match(source('quest-prims-systems.lua'), /UNVERIFIED and it CHANGES THE SAVE/);
});

// ---- the natives, on a fake of the game's own objects -----------------------------------------------------------------------------------------------------------------

const nativesHarness = `
local Worlds = ${load('quest-world-systems.lua')}
${base}
local money = {n = 500}
local store = {}
local items = {}
local equippedSet = {}
local garage = {}
local equipUnreadable = false
local tweakCalls = {}
ItemID = {FromTDBID = function(id) return {tdb = id} end, GetTDBID = function(id) return id.tdb end,
  HasFlag = function(id, flag) return false end}
TweakDBID = {new = function(text) return text end}
TDBID = {ToStringDEBUG = function(id) return id end}
Enum = {new = function(kind, name) return name end}
CName = {new = function(text) return text end}
local function qty(id) if id.tdb == 'Items.money' then return money.n end return store[id.tdb] or 0 end
local transactions = {
  GetItemQuantity = function(_, player, id) return qty(id) end,
  GiveItem = function(_, player, id, n) if id.tdb == 'Items.money' then money.n = money.n + n else store[id.tdb] = (store[id.tdb] or 0) + n end return true end,
  RemoveItem = function(_, player, id, n) if id.tdb == 'Items.money' then money.n = money.n - n else store[id.tdb] = (store[id.tdb] or 0) - n end return true end,
  GetItemList = function() return true, items end,
}
local equipment = {Get = function() return {GetPlayerData = function() if equipUnreadable then return nil end return {IsEquipped = function(_, id) return equippedSet[id.tdb] == true end} end} end}
local vehicles = {
  GetPlayerUnlockedVehicles = function() local list = {} for record in pairs(garage) do list[#list + 1] = {recordID = record} end return list end,
  EnablePlayerVehicle = function(_, record, on, despawn) garage[record] = true; return true end,
}
Game = {GetPlayer = function() return {} end, GetTransactionSystem = function() return transactions end, GetVehicleSystem = function() return vehicles end,
  GetScriptableSystemsContainer = function() return equipment end}
TweakDB = {GetRecord = function(_, name) return store['rec:' .. name] and {} or nil end}
TweakDBInterface = {GetItemRecord = function(id) return {name = id} end}
UIItemsHelper = {GetItemName = function(record, data) return data.label end}
RPGManager = {GetItemCategory = function(id) return 'gamedataItemCategory : ' .. (id.category or 'Consumable') .. ' (1)' end}
local function item(record, fields)
  local t = {record = record, quantity = 1, label = record:gsub('^Items%.', ''), itemType = 'Con_Edible', category = 'Consumable', tags = {}}
  for k, v in pairs(fields or {}) do t[k] = v end
  store[record] = t.quantity
  local id = {tdb = record, category = t.category}
  items[#items + 1] = {GetID = function() return id end, GetQuantity = function() return t.quantity end, HasTag = function(_, tag) return t.tags[tag] == true end,
    GetItemType = function() return 'gamedataItemType : ' .. t.itemType .. ' (1)' end, label = t.label}
end
local W = Worlds.new({tweak = {ensure = function(name, basis, flats) tweakCalls[#tweakCalls + 1] = name; return name ~= 'Items.Bad', 'no' end}, log = log})
`;
const withNatives = code => run(`${nativesHarness}\n${code}`);

test('natives: the purse is read and taken from with a read back, and refuses what it does not have', () => withNatives(`
assert(W.moneyBalance() == 500)
assert(W.moneyTake(120) == true and money.n == 380)
assert(W.moneyTake(1000) == false and money.n == 380, 'never below zero')
assert(W.moneyTake(0) == false and W.moneyTake(-5) == false and W.moneyTake(0 / 0) == false)
`));

test('natives: items are counted, given and taken with a read back, and a bad record name is refused before the game is asked', () => withNatives(`
assert(W.itemCount('Items.Gun') == 0)
assert(W.itemGive('Items.Gun', 2) == true and W.itemCount('Items.Gun') == 2)
assert(W.itemTake('Items.Gun', 1) == true and W.itemCount('Items.Gun') == 1)
assert(W.itemTake('Items.Gun', 5) == false and W.itemCount('Items.Gun') == 1, 'quantity check first')
assert(W.itemGive('bad name', 1) == false and W.itemCount('bad name') == nil and W.itemTake('x y', 1) == false)
assert(W.itemGive('Items.Gun', 0) == false)
store['rec:Items.Gun'] = true
assert(W.itemExists('Items.Gun') == true and W.itemExists('Items.Nope') == false and W.itemExists('no spaces') == false)
`));

test('natives: the gift list holds drinks, food, junk, clothing, weapons, cyberware and programs, and leaves out money, quest items, currency and what V wears', () => withNatives(`
item('Items.Beer')
item('Items.Junk_A', {itemType = 'Gen_Junk', category = 'General'})
item('Items.Jacket', {category = 'Clothing', itemType = 'Clo_Outer'})
item('Items.Gun', {category = 'Weapon', itemType = 'Wea_Pistol'})
item('Items.Chip', {category = 'Cyberware', itemType = 'Cyb_Op'})
item('Items.Hack', {category = 'Programs', itemType = 'Prt_Program', label = 'Short Circuit'})
item('Items.Ring', {category = 'General', itemType = 'Gen_Jewellery'})
item('Items.Wrench', {category = 'General', itemType = 'Gen_Misc'})
item('Items.QuestCard', {tags = {Quest = true}})
item('Items.Euro', {tags = {Currency = true}})
item('Items.money', {category = 'General', itemType = 'Gen_Misc'})
item('Items.Worn', {category = 'Clothing', itemType = 'Clo_Outer'}); equippedSet['Items.Worn'] = true
local rows = W.inventoryGifts(200)
local seen = {}
for _, row in ipairs(rows) do seen[row.record] = row end
for _, record in ipairs({'Items.Beer', 'Items.Junk_A', 'Items.Jacket', 'Items.Gun', 'Items.Chip', 'Items.Hack', 'Items.Ring'}) do assert(seen[record], record) end
for _, record in ipairs({'Items.Wrench', 'Items.QuestCard', 'Items.Euro', 'Items.money', 'Items.Worn'}) do assert(not seen[record], record .. ' must be left out') end
assert(seen['Items.Hack'].name == 'Short Circuit' and seen['Items.Beer'].quantity == 1 and seen['Items.Jacket'].kind == 'Clothing')
assert(#W.inventoryGifts(3) == 3, 'bounded by the limit')
-- Without a readable equipped check, what could be worn stays out.
equipUnreadable = true
local blind = {}
for _, row in ipairs(W.inventoryGifts(200)) do blind[row.record] = true end
assert(blind['Items.Beer'] and blind['Items.Junk_A'] and not blind['Items.Jacket'] and not blind['Items.Gun'] and not blind['Items.Chip'])
`));

test('natives: the garage is read from the unlock list and added with the unlock of the game, which refuses a bad record', () => withNatives(`
assert(W.vehicleOwned('Vehicle.v_a') == false)
local ok = W.vehicleAdd('Vehicle.v_a')
assert(ok == true and W.vehicleOwned('Vehicle.v_a') == true)
local bad, why = W.vehicleAdd('no good'); assert(bad == false and why == 'bad record')
assert(W.vehicleOwned('no good') == nil)
`));

test('natives: castIs compares the entity ID hash of a tagged spawn, and the profile key of a copy', () => withNatives(`
local function entity(hash) return {GetEntityID = function() return {hash = hash} end} end
assert(W.castIs({kind = 'extra', id = {hash = 77}}, entity(77), nil) == true)
assert(W.castIs({kind = 'extra', id = {hash = 77}}, entity(78), nil) == false)
assert(W.castIs({kind = 'extra', id = {hash = 77}}, nil, nil) == false and W.castIs(nil, entity(1), nil) == false)
assert(W.castIs({kind = 'copy', profileKey = 'panam-palmer'}, entity(5), 'panam-palmer') == true)
assert(W.castIs({kind = 'copy', profileKey = 'panam-palmer'}, entity(5), 'judy-alvarez') == false)
`));

test('natives: tweakEnsure goes to the tweak module and reports why it failed; a missing module is a refusal, not an error', () => withNatives(`
assert(W.tweakEnsure('Items.Good', 'Items.Base', {}) == true and tweakCalls[1] == 'Items.Good')
local ok, why = W.tweakEnsure('Items.Bad', 'Items.Base', {}); assert(ok == false and why == 'no')
local lone = Worlds.new({log = log})
local ok2, why2 = lone.tweakEnsure('Items.Good', 'Items.Base', {}); assert(ok2 == false and type(why2) == 'string')
`));

// ---- the play file's data plumbing -----------------------------------------------------------------------------------------------------------------------------

const playHarness = `
${harness}
local files = {}
local play
play = Play.new({enabled = function() return true end, clock = clock, gameTime = function() return game.gameClock end,
  read = function(path) return files[path] end, write = function(path, text) files[path] = text; return true end,
  encode = serialize, decode = decode, places = places, prims = prims, session = 'sess', log = log})
local function step(seconds)
  for _ = 1, seconds do game.now = game.now + 1; game.gameClock = game.gameClock + 1; game.tick = game.tick + 1; play.update('V', 1) end
end
local function setPlay(quests, extra)
  local value = {version = 1, revision = 1, quests = quests}
  for k, v in pairs(extra or {}) do value[k] = v end
  files[Play.PLAY] = serialize(value)
end
local function quest(fields)
  local q = {pack = 'toll-road', character = 'panam-palmer', stage = 'gate', serial = 1, since = 99990, places = {}, ['do'] = {}, script = {}, lines = {}, gaps = {}}
  for k, v in pairs(fields or {}) do q[k] = v end
  return q
end
local function eventsList() return decode(files[Play.EVENTS]).events end
local function eventNamed(name) for _, e in ipairs(eventsList()) do if e.name == name then return e end end return nil end
`;
const withPlay = code => run(`${playHarness}\n${code}\nassert(not game.stale, 'a handle was kept across ticks')`);

test('data: cleanData keeps at most 6 flat scalar keys, strings cut at 80, and drops tables, functions and bad keys', () => withPlay(`
local d = Play.cleanData({a = 1, b = true, c = 'text', d = {1}, e = print, ['bad key!'] = 3, f = 0 / 0})
assert(d.a == 1 and d.b == true and d.c == 'text' and d.d == nil and d.e == nil and d['bad key!'] == nil and d.f == nil)
local many = Play.cleanData({k1 = 1, k2 = 2, k3 = 3, k4 = 4, k5 = 5, k6 = 6, k7 = 7, k8 = 8})
local n = 0 for _ in pairs(many) do n = n + 1 end
assert(n == 6, 'at most six keys: ' .. n)
assert(#Play.cleanData({s = string.rep('x', 200)}).s == 80)
assert(Play.cleanData({s = string.rep('y', 80)}).s == string.rep('y', 80))
assert(Play.cleanData({}) == nil and Play.cleanData('x') == nil and Play.cleanData({d = {}}) == nil)
`));

test('data: a pay stage through the play module: the command offer reaches the listener with its data, and the events file carries the paid event with its data', () => withPlay(`
game.vpos = {x = 0, y = 0, z = 0}
game.spawn = 0
world.castSpawn = function(request) game.casts['g1'] = {attached = true, pos = {x = 2, y = 2, z = 0}}; return {kind = 'extra', id = 'g1'} end
setPlay({quest({['do'] = {{p = 'cast', id = 'guard', who = 'extra', record = 'Character.guard', x = 2, y = 2, z = 0}, {p = 'pay', id = 'toll', to = 'guard', amount = 100, min = 60}},
  script = {{when = 'pay:toll:paid', event = 'gate:open'}}})}, {})
assert(play.restore() == true)
step(8)
assert(eventNamed('cast:guard:arrived'), 'the cast member is there')
assert(#prims.payTargets() == 1 and prims.payTargets()[1].pack == 'toll-road' and prims.payTargets()[1].cast == 'guard')
-- The bridge's command carries the amount.
setPlay({quest({['do'] = {{p = 'cast', id = 'guard', who = 'extra', record = 'Character.guard', x = 2, y = 2, z = 0}, {p = 'pay', id = 'toll', to = 'guard', amount = 100, min = 60}},
  script = {{when = 'pay:toll:paid', event = 'gate:open'}}})}, {commands = {{seq = 1, pack = 'toll-road', serial = 1, cmd = 'event', name = 'pay:toll:offer', data = {amount = 45}}}})
play.onPlayRevision(); step(1)
local short = eventNamed('pay:toll:short')
assert(short and short.data and short.data.amount == 45 and game.money == 500, 'short, nothing taken')
assert(eventNamed('pay:toll:offer') == nil, 'a command event is not reported back')
setPlay({quest({['do'] = {{p = 'cast', id = 'guard', who = 'extra', record = 'Character.guard', x = 2, y = 2, z = 0}, {p = 'pay', id = 'toll', to = 'guard', amount = 100, min = 60}},
  script = {{when = 'pay:toll:paid', event = 'gate:open'}}})}, {commands = {{seq = 2, pack = 'toll-road', serial = 1, cmd = 'event', name = 'pay:toll:offer', data = {amount = 75, junk = {1}}}}})
play.onPlayRevision(); step(1)
local paid = eventNamed('pay:toll:paid')
assert(paid and paid.data.amount == 75 and paid.data.junk == nil and game.money == 425, 'paid with the haggled amount')
assert(eventNamed('gate:open'), 'the stage rows answer the paid event')
assert(eventNamed('gate:open').data == nil, 'an event without data has no data key')
`));

test('data: a listener gets (name, data) from a command, data is cleaned, a command without data gives the listener nil, and the gifts of the quest reach the ctx', () => withPlay(`
local got = {}
prims.defs.listener = {arm = function(ctx, spec)
  ctx:on('x:ping', function(name, data) got[#got + 1] = {name = name, data = data, gifts = ctx.gifts} end)
  return {}
end}
setPlay({quest({['do'] = {{p = 'listener'}}, gifts = {loved = {{prefix = 'Items.Nomad_'}}}})}, {})
play.restore()
local function command(seq, data)
  setPlay({quest({['do'] = {{p = 'listener'}}, gifts = {loved = {{prefix = 'Items.Nomad_'}}}})}, {commands = {{seq = seq, pack = 'toll-road', serial = 1, cmd = 'event', name = 'x:ping', data = data}}})
  play.onPlayRevision()
end
command(1, {amount = 5, words = string.rep('w', 120), a = 1, b = 2, c = 3, d = 4, e = 5, f = 6})
assert(#got == 1 and got[1].name == 'x:ping')
local n = 0 for _, v in pairs(got[1].data) do n = n + 1; if type(v) == 'string' then assert(#v <= 80) end end
assert(n == 6, 'six keys at most')
assert(got[1].gifts and got[1].gifts.loved[1].prefix == 'Items.Nomad_')
command(2, nil)
assert(#got == 2 and got[2].data == nil)
command(3, 'not a table')
assert(#got == 3 and got[3].data == nil)
assert(eventNamed('x:ping') == nil, 'commands are not reported back')
`));

test('data: an event raised by a primitive with data is written with it, one without has none, and probe injection still works', () => withPlay(`
prims.defs.shout = {arm = function(ctx, spec) ctx:after(0, function() ctx:emit('shout:a:done', {item = 'Items.X', count = 2, flag = true, nested = {1}}); ctx:emit('shout:a:plain') end, {real = true}); return {} end}
setPlay({quest({['do'] = {{p = 'shout'}}})}, {})
play.restore(); step(2)
local e = eventNamed('shout:a:done')
assert(e and e.data.item == 'Items.X' and e.data.count == 2 and e.data.flag == true and e.data.nested == nil)
assert(eventNamed('shout:a:plain').data == nil)
assert(play.inject('probe:event') == 1 and eventNamed('probe:event').data == nil)
`));

test('facts accessor: the play file factsWanted is cleaned and held, empty is nil, a bad row is dropped, and the file going away clears it', () => withPlay(`
assert(play.factsWanted() == nil)
setPlay({}, {factsWanted = {
  {id = 'takemura-alive', names = {'q105_takemura_alive', 'q105_other'}, kind = 'bool'},
  {id = 'path', names = {'fact_a', 'fact_b', 'bad name!'}, kind = 'enum', values = {'one', 'two'}},
  {id = 'byname', names = {'n1', 'n2'}, kind = 'enum', values = {n2 = 'second'}},
  {id = 'Bad Id', names = {'x'}, kind = 'bool'}, {id = 'nokind', names = {'x'}, kind = 'int'}, {id = 'nonames', names = {}, kind = 'bool'}, 'junk'}})
play.restore()
local w = play.factsWanted()
assert(#w == 3, #w)
assert(w[1].id == 'takemura-alive' and #w[1].names == 2 and w[1].kind == 'bool' and w[1].values == nil)
assert(#w[2].names == 2 and w[2].values[1] == 'one' and w[2].values[2] == 'two')
assert(w[3].values[1] == nil and w[3].values[2] == 'second', 'values may be keyed by the fact name')
assert(play.status().facts == 3)
setPlay({}, {factsWanted = {}}); play.onPlayRevision(); assert(play.factsWanted() == nil)
setPlay({}, {factsWanted = {{id = 'a', names = {'x'}, kind = 'bool'}}}); play.onPlayRevision(); assert(#play.factsWanted() == 1)
files[Play.PLAY] = nil; step(1); play.onPlayRevision(); step(1)
assert(play.factsWanted() == nil, 'the file is gone')
`));
