import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {lua} from './housemate-fixture.mjs';

// Party companions settle in V's flat (docs/COMPANION_SETTLE.md): the settle module against a fake seating controller and a fake spot
// preparer. The real seating controller and the real spot preparer are exercised in companion-settle-seating.test.mjs.
const EXTRA = ['companion-settle.lua'];
const FIXTURE = `
  local Settle = dofile('companion-settle.lua')
  local calls, logs = {}, {}
  local function count(name) local n = 0; for _, c in ipairs(calls) do if c.name == name then n = n + 1 end end return n end
  local function lastCall(name) for i = #calls, 1, -1 do if calls[i].name == name then return calls[i] end end end
  local seatFake = {held = {}, sittingNow = false, vseat = nil, placedSet = {}, canSitNow = true, homeId = 0}
  local seat = {native = {}}
  function seat.setHome(spec) calls[#calls + 1] = {name = 'setHome'}; seatFake.spec = spec; seatFake.homeId = seatFake.homeId + 1; return seatFake.homeId end
  function seat.clearHome(reason, instant) calls[#calls + 1] = {name = 'clearHome', reason = reason, instant = instant}; seatFake.spec = nil; seatFake.held = {}; seatFake.placedSet = {} end
  function seat.homeHeld() return seatFake.held end
  function seat.sitting() return seatFake.sittingNow end
  function seat.vSeat() return seatFake.vseat end
  function seat.canSit() return seatFake.canSitNow end
  function seat.placed(serial) return seatFake.placedSet[serial] end
  function seat.homeRelease(serial, reason, instant) calls[#calls + 1] = {name = 'homeRelease', serial = serial, reason = reason}; seatFake.placedSet[serial] = nil; return true end
  local SIT = {couch = true, chair = true, bar = true, stool = true}
  local reject, prepared, procs = {}, 0, 0
  local fakeWorld = {
    prepare = function(spot, r)
      prepared = prepared + 1
      if reject[spot.id] then return nil, 'no seat surface' end
      return {kind = spot.kind, x = spot.x, y = spot.y, z = spot.z, yaw = spot.yaw or 0, approach = SIT[spot.kind] and {x = spot.x, y = spot.y + 1, z = spot.z} or nil}
    end,
    proc = function(apartment, r, used) procs = procs + 1; return {x = 100 + #used * 2, y = 100, z = 0} end,
  }
  local v, busy, here, housemates = {x = -1381, y = 1271, z = 123.06}, nil, 'h10', {}
  local vCalls = 0
  local party = {}
  local function member(i) return {serial = i, position = {x = -1380 + i, y = 1270, z = 123.06}} end
  for i = 1, 3 do party[i] = member(i) end
  local function rows() local out = {}; for _, e in ipairs(party) do out[#out + 1] = {entry = e} end return out end
  local settle = Settle.new({
    load = dofile, seating = function() return seat end,
    vpos = function() vCalls = vCalls + 1; return {x = v.x, y = v.y, z = v.z} end,
    held = function() return busy end, district = function() return here end, others = function() return housemates end,
    member = function(entity) local i = tonumber(entity); return party[i] and {serial = i, key = 'k' .. i, name = 'N' .. i} or nil end,
    world = function() return fakeWorld end,
    log = function(kind, fields) logs[#logs + 1] = {kind = kind, fields = fields} end})
  local function lastLog(kind) for i = #logs, 1, -1 do if logs[i].kind == kind then return logs[i].fields end end end
  local function advance(seconds, move)
    for _ = 1, math.floor(seconds / 0.1 + 0.5) do
      if move then v.x = v.x + move * 0.1 end
      settle.tick(nil, 0.1, rows())
    end
  end
  -- What the seating controller does with a claim: the place is held from then on.
  local function claimFor(i)
    local place = seatFake.spec and seatFake.spec.claim(party[i])
    if place then
      seatFake.held[#seatFake.held + 1] = {serial = i, id = place.id, x = place.x, y = place.y, z = place.z}
      seatFake.placedSet[i] = 'seated'
    end
    return place
  end
  local function flat(a, b) return math.sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2) end
  local function settled() advance(0.1); return seatFake.spec ~= nil end
`;
const run = body => lua(`${FIXTURE}\n${body}`, {extra: EXTRA});

test('nothing happens before V is in a flat: no native read, no seating call', () => run(`
  advance(30)
  assert(vCalls == 0 and #calls == 0 and prepared == 0, 'idle module did work')
  assert(settle.snapshot().state == 'idle')
`));

test('V walking through the flat is not settled; V staying is, after STAY seconds and a quiet spell', () => run(`
  settle.enter('h10')
  advance(40, 1.5)   -- a walk: heading somewhere
  assert(seatFake.spec == nil, 'settled while V walks on')
  advance(2.0)
  assert(seatFake.spec == nil, 'V has been still for 2 s only: the quiet spell is 3 s')
  advance(2.0)
  assert(seatFake.spec ~= nil, 'settled once V stayed')
  assert(count('setHome') == 1)
`));

test('V standing still is settled at ten seconds, not before', () => run(`
  settle.enter('h10')
  advance(9.0)
  assert(seatFake.spec == nil, 'too early')
  advance(1.6)
  assert(seatFake.spec ~= nil, 'ten seconds in the flat and still')
`));

test('V sitting down settles them after 1.5 s in the flat', () => run(`
  settle.enter('h10')
  advance(1.0)
  seatFake.sittingNow = true
  advance(0.3)
  assert(seatFake.spec == nil, 'not before 1.5 s in the flat')
  advance(0.5)
  assert(seatFake.spec ~= nil, 'V sat: settle now')
`));

test('nobody to settle: the home is not set up and no seat is looked for', () => run(`
  party = {}
  settle.enter('h10')
  advance(15)
  assert(seatFake.spec == nil and prepared == 0, 'no companions, no work')
`));

test('seats first, nearest, spread: no two companions on one place, a two-seat sofa is two seats', () => run(`
  settle.enter('h10')
  advance(11)
  assert(seatFake.spec ~= nil)
  local ids, seen = {}, {}
  for i = 1, 3 do
    local place = claimFor(i)
    assert(place, 'companion ' .. i .. ' has no place')
    assert(not seen[place.id], 'two companions on ' .. place.id)
    seen[place.id] = true
    ids[#ids + 1] = place.id
  end
  -- H10: the short sofa (two seats), the desk chair, two standing spots (the long sofa may be V's own seat and is not given away)
  local sits = 0
  for _, id in ipairs(ids) do if id:find('couch') or id:find('chair') then sits = sits + 1 end end
  assert(sits == 3, 'seats before standing places: ' .. table.concat(ids, ','))
  assert(seen['h10-couch-short-1'] and seen['h10-couch-short-2'], 'both cushions of the sofa are used')
  assert(not seen['h10-couch-long-1'] and not seen['h10-couch-corner'], 'maybe-V seats are not given away')
`));

test('five companions fill every place of H10, the sixth stands somewhere in the room', () => run(`
  for i = 4, 6 do party[i] = member(i) end
  settle.enter('h10')
  advance(14)
  assert(seatFake.spec ~= nil)
  local seen, kinds = {}, {}
  for i = 1, 5 do
    local place = claimFor(i)
    assert(place and not seen[place.id], 'place ' .. i)
    seen[place.id] = true
    kinds[place.kind] = (kinds[place.kind] or 0) + 1
  end
  assert(kinds.stand == 2, 'two standing places')
  local last = claimFor(6)
  assert(last and last.procedural and last.kind == 'stand' and procs >= 1, 'a procedural standing place for the sixth')
`));

test('the places of the housemates are left alone', () => run(`
  housemates = {{id = 'h10-couch-short-1', x = -1378.59, y = 1266.0, z = 122.7}, {id = 'elsewhere', x = -1385.95, y = 1274.38, z = 123.06}}
  settle.enter('h10')
  advance(11)
  local seen = {}
  for i = 1, 3 do local p = claimFor(i); if p then seen[p.id] = true end end
  assert(not seen['h10-couch-short-1'], 'a housemate sits there')
  assert(not seen['h10-desk-chair'], 'a housemate stands within 0.6 m of the desk chair')
`));

test('the seat V sat on is never given away, and is learned', () => run(`
  settle.enter('h10')
  settle.learnV({x = -1376.3, y = 1268.8, z = 122.7})
  advance(11)
  local seen = {}
  for i = 1, 3 do local p = claimFor(i); if p then seen[p.id] = true end end
  assert(not seen['h10-couch-long-1'], 'V\\'s seat')
  -- Now the seat V sat on is known, the other pieces of that couch are no longer "maybe V's".
  assert(seen['h10-couch-long-2'] or seen['h10-couch-corner'] or seen['h10-couch-short-1'], 'the rest of the sofa is free')
  seatFake.vseat = {x = -1378.59, y = 1266.0, z = 122.7}
  seatFake.held = {}
  seen = {}
  for i = 1, 3 do local p = claimFor(i); if p then seen[p.id] = true end end
  assert(not seen['h10-couch-short-1'], 'V sits on the short sofa now: that cushion is V\\'s')
`));

test('a place V stands next to is not given, and a chosen place stays 0.9 m from the others', () => run(`
  v.x, v.y, v.z = -1378.6, 1266.3, 123.06   -- V stands right at the short sofa
  settle.enter('h10')
  advance(11)
  local seen = {}
  for i = 1, 3 do local p = claimFor(i); if p then seen[p.id] = true end end
  assert(not seen['h10-couch-short-1'], 'within 1 m of V')
  local held = seatFake.held
  for i = 1, #held do for j = i + 1, #held do
    local limit = (held[i].id:find('short') and held[j].id:find('short')) and 0.5 or 0.9
    assert(flat(held[i], held[j]) >= limit, held[i].id .. ' and ' .. held[j].id .. ' are too close')
  end end
`));

test('a seat that cannot be found is dropped; a place that failed is not given again', () => run(`
  reject['h10-couch-short-1'] = true
  settle.enter('h10')
  advance(11)
  local p = claimFor(1)
  assert(p.id ~= 'h10-couch-short-1')
  seatFake.spec.freed(p, true, 'play failed', 1)
  seatFake.held, seatFake.placedSet = {}, {}
  for i = 1, 3 do local q = claimFor(i); assert(q and q.id ~= p.id and q.id ~= 'h10-couch-short-1', 'again ' .. p.id) end
`));

test('no seat component in the archive: standing places only', () => run(`
  seatFake.canSitNow = false
  settle.enter('h10')
  advance(14)
  for i = 1, 2 do local p = claimFor(i); assert(p and p.kind == 'stand', 'no seats: ' .. tostring(p and p.kind)) end
`));

test('a fight ends it at once (instant stand-up); a scene and a car end it; they settle again only after a quiet spell', () => run(`
  settle.enter('h10')
  advance(11)
  assert(seatFake.spec ~= nil)
  busy = 'combat'; advance(0.6)
  local c = lastCall('clearHome')
  assert(c and c.reason == 'combat' and c.instant == true, 'combat releases instantly')
  busy = nil
  advance(5)
  assert(seatFake.spec == nil, 'not again within the quiet spell')
  advance(2.5)
  assert(seatFake.spec ~= nil, 'settled again')
  busy = 'scene'; advance(0.6)
  assert(lastCall('clearHome').reason == 'scene' and lastCall('clearHome').instant == false)
  busy = nil; advance(8)
  assert(seatFake.spec ~= nil)
  busy = 'car'; advance(0.6)
  assert(lastCall('clearHome').reason == 'car')
  assert(count('setHome') == 3 and count('clearHome') == 3)
`));

test('a long scene does not use the clock up: they wait the quiet spell after it, however long it was', () => run(`
  settle.enter('h10')
  busy = 'scene'
  advance(60)
  assert(seatFake.spec == nil, 'never settled during a scene')
  busy = nil
  advance(5)
  assert(seatFake.spec == nil)
  advance(4)
  assert(seatFake.spec ~= nil)
`));

test('V going far from the nearest settled companion (or to another floor) ends it', () => run(`
  settle.enter('h10')
  advance(11)
  claimFor(1); claimFor(2)
  party[1].position = {x = -1380, y = 1270, z = 123.06}
  party[2].position = {x = -1381, y = 1270, z = 123.06}
  v.x, v.y = -1380, 1270
  advance(1)
  assert(seatFake.spec ~= nil, 'near them')
  v.x = -1380 + 20
  advance(1)
  assert(lastCall('clearHome') and lastCall('clearHome').reason == 'far', 'V is 19 m away')
  assert(seatFake.spec == nil)
`));

test('a district check every few seconds catches a missed event: V is no longer in the flat', () => run(`
  settle.enter('h10')
  advance(11)
  assert(seatFake.spec ~= nil)
  here = nil
  advance(7)
  assert(lastCall('clearHome') and lastCall('clearHome').reason == 'left the flat')
  assert(settle.snapshot().state == 'idle')
  local read = vCalls
  advance(10)
  assert(vCalls == read, 'idle again: no further reads')
`));

test('leaving the flat by the district event frees everyone; entering another flat starts over', () => run(`
  settle.enter('h10')
  advance(11)
  settle.leave('left the flat')
  assert(lastCall('clearHome').reason == 'left the flat' and settle.snapshot().state == 'idle')
  here = 'corpo'
  settle.enter('corpo')
  assert(settle.snapshot().apt == 'corpo' and seatFake.spec == nil)
  advance(11)
  local p = claimFor(1)
  assert(p and p.id:find('corpo'), 'a place of the other flat: ' .. tostring(p and p.id))
`));

test('"come with me": only a settled companion is offered the follow, and following lets her go', () => run(`
  settle.enter('h10')
  advance(11)
  assert(settle.followOffer('1', {profileKey = 'k1', name = 'Judy'}) == nil, 'no place yet')
  claimFor(1)
  local offer = settle.followOffer('1', {profileKey = 'k1', name = 'Judy'})
  assert(offer and offer.available == true and offer.actor.id == '1' and offer.actor.key == 'k1' and offer.name == 'Judy')
  assert(settle.followOffer('2', {profileKey = 'k2'}) == nil, 'companion 2 has no place')
  assert(settle.follow('1') == true and lastCall('homeRelease').serial == 1 and lastCall('homeRelease').reason == 'follow')
  assert(settle.follow('9') == false)
`));

test('the places the party holds are shown to the housemates only while settled in that flat', () => run(`
  assert(settle.taken('h10') == nil)
  settle.enter('h10')
  assert(settle.taken('h10') == nil, 'not settled yet')
  advance(11)
  local p = claimFor(1)
  local taken = settle.taken('h10')
  assert(#taken == 1 and taken[1].id == p.id)
  assert(settle.taken('corpo') == nil)
`));

test('spot preparation is bounded: it stops once there are places for everybody plus a spare, and it never runs idle', () => run(`
  settle.enter('h10')
  advance(11)
  assert(prepared <= 4 + 2, 'prepared ' .. prepared .. ' for three companions')
  local before = prepared
  advance(20)
  assert(prepared == before, 'no more work once there are places')
`));

test('every game read goes through the injected seams: the module never calls the game itself', () => {
  const lines = readFileSync(new URL('../mod/companion-settle.lua', import.meta.url), 'utf8').split(/\r?\n/);
  const source = lines.filter(line => !line.trim().startsWith('--')).join(' ');
  assert.equal(/\bGame\./.test(source), false, 'no Game.* call in companion-settle.lua');
  assert.equal(/ObserveAfter|ObserveBefore|Observe\(/.test(source), false, 'no hook in the module');
});

test('init.lua: the district event is the only thing that wakes it, and away from home the tick is one nil global', () => {
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
  assert.match(init, /ObserveAfter\('PreventionSystem', 'OnDistrictAreaEntered', function\(\)\s*if not worldSuspended and convaiSettleWake then convaiSettleWake\(\) end/);
  assert.match(init, /local z = convaiSettle\s*\r?\n\s*if z then pcall\(z\.tick, player, step, rows\) end/);
  assert.match(init, /\nconvaiSettle = nil\r?\ndo\r?\n/);
  // The first party tick of a world is the only other trigger: the seating controller asks once (options.onWorld); the frame loop never does.
  assert.match(init, /onWorld = function\(\) if convaiSettleWake then convaiSettleWake\(\) end end/);
  assert.equal(/convaiSettlePending/.test(init), false);
  // No per-tick read of the district anywhere in the settle block.
  const block = init.slice(init.indexOf('-- ---- Companions settle in V\'s flat'), init.indexOf('-- Johnny speaks up (docs/JOHNNY_IN_YOUR_HEAD.md, phase 2)'));
  assert.ok(block.length > 500);
  assert.equal(/function convaiSettleTick/.test(block), false);
});
