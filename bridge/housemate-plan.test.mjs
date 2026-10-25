import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lua, fnv} from './housemate-fixture.mjs';

test('the registry hashes a profile key exactly like FNV-1a 32', () => {
  const keys = ['judy-alvarez', 'panam-palmer', 'rogue', 'a', 'johnny-silverhand', 'river-ward'];
  const expected = Object.fromEntries(keys.map(key => [key, fnv(key)]));
  lua(`
    local registry = dofile('housemate-registry.lua')
    local expected = ${JSON.stringify(expected).replace(/"([^"]+)":/g, '["$1"]=').replace(/}/g, '}')}
    for key, value in pairs(expected) do
      assert(registry.hash(key) == value, key .. ' ' .. registry.hash(key) .. ' ~= ' .. value)
    end
    assert(registry.factName('judy-alvarez') == 'cyberpunkconvai_hm_' .. registry.hex(expected['judy-alvarez']))
    assert(registry.hex(255) == '000000ff' and registry.hex(4294967295) == 'ffffffff')
  `);
});

test('the registry writes and reads a flat per profile and ignores numbers outside 1..5', () => {
  lua(`
    local registry = dofile('housemate-registry.lua')
    local values = {}
    local store = {get = function(name) return values[name] or 0 end, set = function(name, value) values[name] = value end}
    assert(registry.write(store, 'judy-alvarez', 'glen'))
    assert(registry.write(store, 'rogue', 'h10'))
    assert(values[registry.factName('judy-alvarez')] == 3)
    local homes = registry.read(store, {'judy-alvarez', 'rogue', 'panam-palmer'})
    assert(homes['judy-alvarez'] == 'glen' and homes['rogue'] == 'h10' and homes['panam-palmer'] == nil)
    assert(registry.write(store, 'judy-alvarez', nil))
    assert(registry.read(store, {'judy-alvarez'})['judy-alvarez'] == nil)
    assert(registry.write(store, 'x', 'moon') == false)
    values[registry.factName('bad')] = 9
    assert(registry.read(store, {'bad'}).bad == nil)
    -- a store that throws is a failed write, not an error
    local broken = {get = function() error('no') end, set = function() error('no') end}
    assert(registry.write(broken, 'a', 'h10') == false)
    assert(next(registry.read(broken, {'a'})) == nil)
  `);
});

test('day and night, bedtimes and wake times are stable per person and inside their windows', () => {
  lua(`
    local plan = dofile('housemate-plan.lua')
    assert(plan.period(12) == 'day' and plan.period(22) == 'night' and plan.period(3) == 'night' and plan.period(6) == 'day')
    for _, key in ipairs({'judy-alvarez', 'rogue', 'panam-palmer', 'river-ward', 'kerry-eurodyne', 'misty-olszewski'}) do
      local bed, wake = plan.bedtime(key), plan.waketime(key)
      assert(bed >= 23 and bed < 24.5, key .. ' bed ' .. bed)
      assert(wake >= 6.5 and wake < 8.5, key .. ' wake ' .. wake)
      assert(plan.bedtime(key) == bed)
      assert(not plan.sleepy(key, 12) and not plan.sleepy(key, 21))
      assert(plan.sleepy(key, 3) and plan.sleepy(key, 5.9))
      assert(not plan.sleepy(key, 9))
      assert(not plan.sleepy(key, bed - 0.01) and plan.sleepy(key, bed + 0.01 > 24 and bed + 0.01 - 24 or bed + 0.01))
    end
    -- people do not all fall asleep in the same minute
    local seen = {}
    for _, key in ipairs({'a','b','c','d','e','f','g','h'}) do seen[string.format('%.2f', plan.bedtime(key))] = true end
    local n = 0 for _ in pairs(seen) do n = n + 1 end
    assert(n >= 4, 'bedtimes too alike: ' .. n)
  `);
});

const SPOTS = `
  local couch = {}
  for i = 1, 3 do couch[#couch + 1] = {id = 'couch-' .. i, kind = 'couch', x = i * 0.66, y = 0, z = 0, group = 'couch'} end
  local spots = {
    couch[1], couch[2], couch[3],
    {id = 'chair-1', kind = 'chair', x = 5, y = 0, z = 0},
    {id = 'bar-1', kind = 'bar', x = 8, y = 4, z = 0},
    {id = 'window-1', kind = 'window', x = 0, y = 9, z = 0},
    {id = 'lean-1', kind = 'lean', x = 9, y = 9, z = 0},
    {id = 'stand-1', kind = 'stand', x = -4, y = 4, z = 0},
  }
  local function residents(n) local list = {} for i = 1, n do list[i] = {key = 'person-' .. i} end return list end
  local function counter(values) local i = 0 return function() i = i + 1 return values[(i - 1) % #values + 1] end end
`;

test('assignment: most sit, nobody shares a place, V slots and a seat near V are never given', () => {
  lua(`${SPOTS}
    local plan = dofile('housemate-plan.lua')
    local result = plan.assign{residents = residents(4), spots = spots, random = counter({0.9, 0.2}), v = {x = 100, y = 100, z = 0}, day = 3}
    local used, sit, stand = {}, 0, 0
    for key, choice in pairs(result) do
      if choice.spot then assert(not used[choice.spot.id], 'shared ' .. choice.spot.id); used[choice.spot.id] = true end
      if choice.spot and plan.SIT_KINDS[choice.spot.kind] then sit = sit + 1 else stand = stand + 1 end
    end
    assert(sit >= 3, 'sit ' .. sit)
    -- six seats worth of people on five seats: one stands (on a procedural place when no stand spot is left)
    local many = plan.assign{residents = residents(9), spots = spots, random = counter({0.5}), v = {x = 100, y = 100, z = 0}, day = 3}
    local seats, others = 0, 0
    for _, choice in pairs(many) do
      if choice.spot and plan.SIT_KINDS[choice.spot.kind] then seats = seats + 1 else others = others + 1 end
    end
    assert(seats == 5, 'seats ' .. seats)
    assert(others == 4)
    -- a place close to V is not given away
    local near = plan.assign{residents = residents(1), spots = {{id = 'a', kind = 'chair', x = 0.5, y = 0, z = 0}}, v = {x = 0, y = 0, z = 0}}
    assert(near['person-1'].spot == nil)
    -- the same people on the same day keep their seats; another day they are dealt again
    local one = plan.assign{residents = residents(3), spots = spots, random = counter({0.5}), v = {x = 100, y = 100, z = 0}, day = 7}
    local two = plan.assign{residents = residents(3), spots = spots, random = counter({0.5}), v = {x = 100, y = 100, z = 0}, day = 7}
    for key, choice in pairs(one) do assert(choice.spot == two[key].spot) end
  `);
});

test('usable: vslots, seats that may be V\'s, recorded roots, rejected spots and beds that do not fit two are left out', () => {
  lua(`
    local plan = dofile('housemate-plan.lua')
    local apartment = {spots = {
      {id = 'v', kind = 'couch', x = 0, y = 0, z = 0, vslot = true},
      {id = 'maybe', kind = 'couch', x = 2, y = 0, z = 0, maybeV = true},
      {id = 'ok', kind = 'couch', x = 4, y = 0, z = 0},
      {id = 'off', kind = 'chair', x = 6, y = 0, z = 0, usable = false},
      {id = 'bad', kind = 'chair', x = 8, y = 0, z = 0},
      {id = 'bed', kind = 'bed', x = 10, y = 0, z = 0, anchor = {x = 10, y = 0, z = 0}, across = 0, sides = {-1, 1}},
    }}
    local function ids(list) local out = {} for _, s in ipairs(list) do out[#out + 1] = s.id end table.sort(out) return table.concat(out, ',') end
    assert(ids(plan.usable(apartment, {rejected = {bad = true}})) == 'ok')
    assert(ids(plan.usable(apartment, {rejected = {bad = true}, knownV = true})) == 'maybe,ok')
    -- a root V sat on takes the seat out, whatever its data says
    assert(ids(plan.usable(apartment, {rejected = {bad = true}, knownV = true, learned = {{x = 4.2, y = 0, z = 0}}})) == 'maybe')
    -- a bed counts only when it was measured to fit two, and gives one slot per side
    apartment.spots[6].fitsTwo = true
    local list = plan.usable(apartment, {rejected = {bad = true}})
    assert(ids(list) == 'bed:1,bed:2,ok', ids(list))
    for _, spot in ipairs(list) do if spot.kind == 'bed' then assert(math.abs(math.abs(spot.x - 10) - 1) < 1e-6 or math.abs(math.abs(spot.y) - 1) < 1e-6) end end
  `);
});

test('sleeping: the bed slot first, a seat to doze in otherwise, nothing for a body type without the animation', () => {
  lua(`${SPOTS}
    local plan = dofile('housemate-plan.lua')
    local bed = {id = 'bed:1', kind = 'bed', x = 20, y = 0, z = 0, yaw = 0}
    local withBed = {bed, table.unpack(spots)}
    local r = plan.assign{residents = residents(2), spots = withBed, sleepers = {['person-1'] = true, ['person-2'] = true}, v = {x = 100, y = 100, z = 0}, day = 1}
    local beds, doze = 0, 0
    for _, choice in pairs(r) do
      assert(choice.sleep == true)
      if choice.spot.kind == 'bed' then beds = beds + 1 else assert(plan.DOZE_KINDS[choice.spot.kind]); doze = doze + 1 end
    end
    assert(beds == 1 and doze == 1)
    -- no bed spot and no chair: she stays up (a couch seat is not a place to doze)
    local none = plan.assign{residents = {{key = 'x'}}, spots = {couch[1]}, sleepers = {x = true}, v = {x = 100, y = 100, z = 0}}
    assert(none.x.sleep == false)
    -- a body type that has no double-bed animation does not take the bed
    local big = plan.assign{residents = {{key = 'big', canBed = false}}, spots = {bed}, sleepers = {big = true}, v = {x = 100, y = 100, z = 0}}
    assert(big.big.sleep == false)
  `);
});

test('next: another spot than the current one, drawn from the day weights', () => {
  lua(`${SPOTS}
    local plan = dofile('housemate-plan.lua')
    local seen = {}
    for step = 1, 40 do
      local choice = plan.next{resident = {key = 'person-1'}, spots = spots, current = spots[1], fixed = {}, v = {x = 100, y = 100, z = 0},
        random = counter({(step * 0.137) % 1, (step * 0.311) % 1})}
      assert(choice.spot == nil or choice.spot.id ~= 'couch-1')
      seen[choice.spot and choice.spot.kind or 'proc'] = true
    end
    assert(seen.couch or seen.chair or seen.bar, 'she never sits')
    assert(seen.window or seen.lean or seen.stand or seen.proc, 'she never stands')
  `);
});
