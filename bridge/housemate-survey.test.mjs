import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {lua} from './housemate-fixture.mjs';

// The development tools of phase 0, against a fake game: a floor, a bed made of a box, V at a chosen pose.
const SURVEY = `
  local written = {}
  local realOpen = io.open
  io.open = function(path, mode)
    if mode == 'ab' or mode == 'wb' then
      return {write = function(self, ...) for _, part in ipairs({...}) do written[path] = (written[path] or '') .. part end end, close = function() end}
    end
    return nil
  end
  json = {encode = function() return '{}' end}
  local facts = {}
  local pos = {x = 0, y = 0, z = 0}
  local yaw = 0
  local surfaces = {}   -- boxes {x1,x2,y1,y2,h}
  local function surfaceAt(x, y, top, bottom)
    local best
    for _, b in ipairs(surfaces) do if x >= b.x1 and x <= b.x2 and y >= b.y1 and y <= b.y2 and b.h <= top and b.h >= bottom and (not best or b.h > best) then best = b.h end end
    return best
  end
  Game = {
    GetPlayer = function() return {
      GetWorldPosition = function() return {x = pos.x, y = pos.y, z = pos.z} end,
      GetWorldOrientation = function() return {ToEulerAngles = function() return {yaw = yaw} end} end} end,
    GetQuestsSystem = function() return {GetFactStr = function(self, n) return facts[n] or 0 end, SetFactStr = function(self, n, v) facts[n] = v end} end,
    GetSpatialQueriesSystem = function() return {SyncRaycastByCollisionGroup = function(self, a, b)
      -- a wall at x = 2
      return (a.x < 2 and b.x >= 2) end} end,
    GetTeleportationFacility = function() return {Teleport = function(self, p, v, e) written.teleported = {v.x, v.y, v.z, e.yaw} end} end,
  }
  Vector4 = {new = function(x, y, z, w) return {x = x, y = y, z = z, w = w} end}
  EulerAngles = {new = function(a, b, c) return {yaw = c} end}
  CName = {new = function(s) return s end}
  convaiSeating = {native = {
    surface = function(x, y, top, bottom) return surfaceAt(x, y, top, bottom) end,
    playerSeat = function() return {inside = false} end}}
  local survey = dofile('housemate-survey.lua')
  local function run(...) return survey.command({'housemate', ...}) end
`;

test('record writes a spot line with V\'s pose, measured', () => {
  lua(`${SURVEY}
    pos = {x = -1602.304, y = 356.2, z = 48.62}; yaw = 18.54
    local ok, result = run('record', 'couch', 'corpo-couch-9', 'next', 'to', 'the', 'lamp')
    assert(ok == true, tostring(result))
    assert(result.line == "{id = 'corpo-couch-9', kind = 'couch', x = -1602.30, y = 356.20, z = 48.62, yaw = 18.5, conf = 'M', note = \\"next to the lamp\\"},", result.line)
    assert(written['runtime/housemate-survey.txt']:find('corpo%-couch%-9'))
    assert(select(1, run('record', 'moon', 'x')) == false)
    assert(select(1, run('record', 'couch')) == false)
  `);
});

test('bed measures how far the bed reaches on each side of V and offers a slot only where a body fits', () => {
  lua(`${SURVEY}
    -- a bed 2.4 m wide across x (-1.2..1.2 around x=0), 3 m long; V lies at x = -0.2, facing +y (yaw 0): lateral axis is x
    surfaces = {{x1 = -1.4, x2 = 1.0, y1 = -1.5, y2 = 1.5, h = 0.5}}
    pos = {x = -0.2, y = 0, z = 0.5}; yaw = 0
    local ok, result = run('bed', 'x-bed')
    assert(ok == true)
    -- left of V (toward -x) reaches to -1.4: 1.2 m; right toward +x reaches 1.0: 1.2 m -> both sides fit
    assert(math.abs(result.left - 1.2) < 0.15 and math.abs(result.right - 1.2) < 0.15, result.left .. ' ' .. result.right)
    assert(result.fitsTwo == true)
    assert(result.line:find('fitsTwo = true') and result.line:find("kind = 'bed'") and result.line:find('sides = {'))
    -- a narrow bed fits one slot or none
    surfaces = {{x1 = -0.5, x2 = 0.5, y1 = -1.5, y2 = 1.5, h = 0.5}}
    pos = {x = 0, y = 0, z = 0.5}
    local _, narrow = run('bed', 'narrow')
    assert(narrow.fitsTwo == false and narrow.line:find('fitsTwo = false'))
  `);
});

test('window finds the glass in front of V and writes the point V looks at', () => {
  lua(`${SURVEY}
    pos = {x = 0, y = 0, z = 0}; yaw = -90   -- facing +x
    local ok, result = run('window', 'w1')
    assert(ok == true and result.glassAt and math.abs(result.glassAt - 2) < 0.15, tostring(result.glassAt))
    assert(result.line:find("kind = 'window'") and result.line:find('face = {x = 2'))
  `);
});

test('scan lists the seat-height surfaces around V as clusters with a guess', () => {
  lua(`${SURVEY}
    pos = {x = 0, y = 0, z = 0}; yaw = 0
    surfaces = {
      {x1 = 2, x2 = 3.9, y1 = 0, y2 = 0.8, h = 0.45},        -- a couch 1.9 x 0.8
      {x1 = -3, x2 = -2.5, y1 = -1, y2 = -0.5, h = 0.75},    -- a stool
      {x1 = 4, x2 = 6.5, y1 = -4, y2 = -1.5, h = 0.5},       -- a bed
    }
    local ok, result = run('scan', '8')
    assert(ok == true)
    local guesses = {}
    for _, c in ipairs(result.clusters) do guesses[c.guess] = (guesses[c.guess] or 0) + 1 end
    assert(guesses.couch == 1 and guesses.stool == 1 and guesses.bed == 1, require and '' or 'guesses')
  `);
});

test('own sets a purchase fact, teleport moves V, qualify writes and reads the registry probe', () => {
  lua(`${SURVEY}
    assert(select(1, run('own', 'h10')) == false, 'h10 is always V\\'s')
    local ok = run('own', 'glen', '1')
    assert(ok == true and facts.dlc6_apart_hey_gle_purchased == 1)
    assert(select(1, run('teleport', 'corpo')) == true and written.teleported[1] == -1606.33)
    assert(select(1, run('teleport', 'moon')) == false)
    local _, wrote = run('qualify', 'write')
    assert(wrote.wrote >= 1000 and wrote.readBack == wrote.wrote)
    -- the file the probe wrote is read back by 'read'
    io.open = function(path, mode) if mode == 'rb' and path == 'runtime/housemate-qualify.txt' then return {read = function() return tostring(wrote.wrote) end, close = function() end} end return nil end
    local _, read = run('qualify', 'read')
    assert(read.survived == true)
    facts.cyberpunkconvai_hm_probe = 0   -- an older save
    local _, older = run('qualify', 'read')
    assert(older.survived == false and older.fact == 0)
  `);
});

test('where and reserved report the flat and the facts that matter there', () => {
  lua(`${SURVEY}
    local ok, where = run('where')
    assert(ok == true and where.purchased.dlc6_apart_cct_dtn_purchased == 0 and where.pose.x == 0)
    local failed = run('reserved')
    assert(failed == false, 'reserved outside a flat is an error')
  `);
});

test('the probe has the command and the survey never reaches a player by itself', () => {
  const probe = readFileSync(new URL('../mod/gesture-probe.lua', import.meta.url), 'utf8');
  assert.match(probe, /COMMANDS\.housemate = function\(words\)/);
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
  assert.doesNotMatch(init, /housemate-survey/);
});
