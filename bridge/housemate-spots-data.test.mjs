import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {lua} from './housemate-fixture.mjs';

// The apartment tables and the constants the controller keeps beside them.
test('every spot is well formed: unique id, known kind, numbers, a facing where the kind needs one', () => {
  lua(`
    local data = dofile('housemate-spots-data.lua')
    local kinds = {couch = true, chair = true, bar = true, stool = true, lean = true, stand = true, window = true, sink = true, bed = true}
    local ids = {}
    for aptId, apartment in pairs(data.apartments) do
      assert(apartment.id == aptId, aptId)
      assert(type(apartment.name) == 'string' and type(apartment.district) == 'string', aptId)
      for _, spot in ipairs(apartment.spots) do
        assert(not ids[spot.id], 'duplicate id ' .. spot.id); ids[spot.id] = true
        assert(spot.id:sub(1, #aptId) == aptId, spot.id .. ' is not in ' .. aptId)
        assert(kinds[spot.kind], spot.id .. ' kind ' .. tostring(spot.kind))
        assert(type(spot.x) == 'number' and type(spot.y) == 'number' and type(spot.z) == 'number', spot.id)
        assert(spot.conf == 'M' or spot.conf == 'A' or spot.conf == 'Q' or spot.conf == 'I', spot.id .. ' conf')
        if spot.kind == 'lean' or spot.kind == 'sink' then assert(spot.usable == false, spot.id .. ' needs a facing before it is used') end
        if spot.conf == 'M' and spot.kind ~= 'bed' and not spot.vslot and spot.kind ~= 'window' then assert(spot.yaw, spot.id .. ' measured without a yaw') end
        if spot.kind == 'bed' then
          assert(spot.anchor and type(spot.across) == 'number' and type(spot.sides) == 'table' and #spot.sides >= 1, spot.id)
          -- a bed is used only when it was measured to fit two
          if spot.fitsTwo ~= true then assert(spot.usable == false, spot.id .. ' is used without a measured width') end
          for _, offset in ipairs(spot.sides) do assert(math.abs(offset) >= 0.5 and math.abs(offset) <= 1.2, spot.id .. ' side ' .. offset) end
        end
        if spot.vslot then assert(spot.conf == 'M', spot.id .. ' a V slot must be measured') end
      end
    end
  `);
});

test('the controller, the registry and the data agree on the five flats', () => {
  lua(`
    local data = dofile('housemate-spots-data.lua')
    local controller = dofile('housemates.lua')
    local registry = dofile('housemate-registry.lua')
    for index, id in ipairs(data.order) do
      assert(registry.APARTMENTS[index] == id and controller.ORDER[index] == id, id)
      assert(data.apartments[id], id)
      assert(controller.DISTRICTS[data.apartments[id].district] == id, id .. ' district')
      assert(controller.NAMES[id] == data.apartments[id].name, id .. ' name')
      assert(data.byDistrict[data.apartments[id].district] == id)
      local fact = controller.FACTS[id]
      assert(fact == data.apartments[id].fact, id .. ' fact')
    end
    assert(#data.order == 5 and data.apartments.h10.fact == nil)
  `);
});

test('V\'s measured couch seat is never given away, and the seat beside it is a seat of the same couch 0.66 m to its left', () => {
  lua(`
    local data = dofile('housemate-spots-data.lua')
    local plan = dofile('housemate-plan.lua')
    local corpo = data.apartments.corpo
    local v, two
    for _, spot in ipairs(corpo.spots) do
      if spot.id == 'corpo-couch-v' then v = spot elseif spot.id == 'corpo-couch-2' then two = spot end
    end
    assert(v and v.vslot and two and two.group == v.group and two.yaw == v.yaw)
    local d = math.sqrt((v.x - two.x) ^ 2 + (v.y - two.y) ^ 2)
    assert(math.abs(d - 0.66) < 0.02, 'distance ' .. d)
    -- to V's left: the left of the facing (-cos, -sin of the yaw)
    local r = math.rad(v.yaw)
    local lx, ly = -math.cos(r), -math.sin(r)
    assert(((two.x - v.x) * lx + (two.y - v.y) * ly) > 0.6)
    for _, spot in ipairs(plan.usable(corpo, {})) do assert(spot.id ~= 'corpo-couch-v') end
    -- the seats that may be V's are held back until V's seats in the flat are known
    local held = {}
    for _, spot in ipairs(plan.usable(data.apartments.h10, {})) do held[spot.id] = true end
    assert(not held['h10-couch-long-1'] and held['h10-couch-short-1'])
  `);
});

test('the reserved facts are plain fact names, none of them an ownership fact or the global apartment switch', () => {
  lua(`
    local data = dofile('housemate-spots-data.lua')
    for group, list in pairs(data.reservedFacts) do
      for _, name in ipairs(list) do
        assert(name:match('^[a-z0-9_]+$'), group .. ' ' .. name)
        assert(not name:match('_purchased$'), name .. ' is an ownership fact')
        assert(name ~= 'apartment_on', 'apartment_on is a global switch, not a scene')
      end
    end
    assert(data.reservedFacts.any and data.reservedFacts.h10 and data.reservedFacts.corpo)
  `);
});

test('no two usable spots are closer than 0.4 m unless they are seats of the same piece of furniture', () => {
  lua(`
    local data = dofile('housemate-spots-data.lua')
    for aptId, apartment in pairs(data.apartments) do
      local list = {}
      for _, spot in ipairs(apartment.spots) do if spot.usable ~= false and spot.kind ~= 'bed' then list[#list + 1] = spot end end
      for i = 1, #list do
        for j = i + 1, #list do
          local d = math.sqrt((list[i].x - list[j].x) ^ 2 + (list[i].y - list[j].y) ^ 2)
          assert(d >= 0.4 or (list[i].group and list[i].group == list[j].group), list[i].id .. ' and ' .. list[j].id .. ' d=' .. d)
        end
      end
    end
  `);
});

test('the new archive components are named in the gesture catalogue and in gestures.json, one for one', () => {
  const catalog = readFileSync(new URL('../mod/gesture-catalog.lua', import.meta.url), 'utf8');
  const source = JSON.parse(readFileSync(new URL('../assets/gestures/gestures.json', import.meta.url), 'utf8'));
  for (const key of ['bed', 'chairsleep', 'lean', 'sink']) {
    assert.ok(source.seatWorkspots[key], key);
    assert.match(catalog, new RegExp(`${key} = "convai_sit_${key}"`), key);
  }
  assert.match(source.seatWorkspots.bed, /generic__lie_double_bed__sleep__01/);
  assert.match(source.seatWorkspots.chairsleep, /generic__sit_chair__sleep__01/);
  // the world adapter plays exactly these components
  const world = readFileSync(new URL('../mod/housemate-world.lua', import.meta.url), 'utf8');
  for (const key of ['couch', 'chair', 'bar', 'stool', 'lean', 'sink', 'bed']) assert.match(world, new RegExp(`${key} = '${key}'`), key);
  assert.match(world, /chairsleep/);
});

test('every housemate Lua file and bridge module is in the release plan and the development file list', () => {
  const release = readFileSync(new URL('../packaging/release-plan.json', import.meta.url), 'utf8');
  const development = readFileSync(new URL('../scripts/development-files.json', import.meta.url), 'utf8');
  for (const name of ['housemates', 'housemate-registry', 'housemate-plan', 'housemate-chat', 'housemate-world', 'housemate-service', 'housemate-spots-data', 'housemate-survey']) {
    assert.ok(release.includes(`mod/${name}.lua`), `${name} in the release plan`);
    assert.ok(development.includes(`mod/${name}.lua`), `${name} in the development files`);
  }
  for (const name of ['home-requests', 'house-chat']) assert.ok(release.includes(`bridge/${name}.mjs`), name);
});
