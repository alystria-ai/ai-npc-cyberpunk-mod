// Bond quests and Characters text first, in person (30 Oct live test): a character who stands beside V does not text. A quest that V began in person leaves its plain text
// rows out while she is near (she says it in her reply), a quest begun by Phone Chat or a holocall still texts, a picture text is always sent, and a reach-out waits until
// she is not near. Run on the same fake game as quest-play-lua.test.mjs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run, load, source, base} from './quest-lua-fixture.mjs';

const harness = `
local Places = ${load('quest-places.lua')}
local Prims = ${load('quest-prims.lua')}
local Lines = ${load('quest-lines.lua')}
local Play = ${load('quest-play.lua')}
${base}
local game = {now = 0, gameClock = 100000, rate = 1, tick = 0, enabled = true, files = {}, reads = 0, writes = 0, decodes = 0, vpos = {x = 0, y = 0, z = 0},
  copy = nil, seated = {v = false, copy = false}, stale = false, pinAdds = 0, pinRemoves = 0, pins = {}, started = {}, phones = {}, subtitles = {}, spawnCalls = {},
  deleted = {}, attached = {}, nextHandle = 1, busy = false, nextRequest = 1, writeFails = false}
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
  seated = function() return fresh({v = game.seated.v, copy = game.seated.copy}) end,
  rayDown = function() return nil end,
  pinAdd = function() game.pinAdds = game.pinAdds + 1; local id = 'pin' .. game.pinAdds; game.pins[id] = true; return id end,
  pinRemove = function(id) game.pinRemoves = game.pinRemoves + 1; game.pins[id] = nil end,
  castSpawn = function(request)
    game.spawnCalls[#game.spawnCalls + 1] = request
    local handle = {id = 'h' .. game.nextHandle}; game.nextHandle = game.nextHandle + 1
    return handle
  end,
  castLookup = function(handle) if not game.attached[handle.id] then return nil end return fresh({position = fresh(game.attached[handle.id])}) end,
  castDelete = function(handle) game.deleted[#game.deleted + 1] = handle.id end,
}
local clock = function() return game.now end
local places = Places.new({world = world, clock = clock, log = log})
local prims = Prims.new({places = places, world = world, clock = clock, gameTime = function() return game.gameClock end, log = log})
local play
local lines = Lines.new({clock = clock, gameTime = function() return game.gameClock end, log = log,
  busy = function() return game.busy end,
  start = function(entry) local id = 'r' .. game.nextRequest; game.nextRequest = game.nextRequest + 1; game.started[#game.started + 1] = entry; return id end,
  subtitle = function(key, text) game.subtitles[#game.subtitles + 1] = text end,
  phone = function(key, text, image) game.phones[#game.phones + 1] = {key = key, text = text, image = image}; return true end,
  emit = function(pack, name) play.emitPack(pack, name) end,
  onChange = function() play.rearm() end})
play = Play.new({
  enabled = function() return game.enabled end, clock = clock, gameTime = function() return game.gameClock end,
  read = function(path) game.reads = game.reads + 1; return game.files[path] end,
  write = function(path, text) if game.writeFails then return false end game.files[path] = text; game.writes = game.writes + 1; return true end,
  encode = serialize, decode = function(text) game.decodes = game.decodes + 1; return decode(text) end,
  places = places, lines = lines, prims = prims, session = 'sess1', log = log,
  near = function(key) game.nearAsks = (game.nearAsks or 0) + 1; return game.near == key end})
local function step(seconds)
  for _ = 1, math.floor(seconds * 10 + 0.5) do
    game.now = game.now + 0.1; game.gameClock = game.gameClock + 0.1 * game.rate; game.tick = game.tick + 1
    play.update('V', 0.1)
  end
end
local function setPlay(value) game.files[Play.PLAY] = serialize(value) end
local function quest(fields)
  local q = {pack = 'panam-sunset-coffee', character = 'panam-palmer', stage = 'walk', serial = 1, since = 99990,
    places = {sunset = {x = 100, y = 200, z = 10, radius = 25}}, ['do'] = {}, script = {}, lines = {}, gaps = {}}
  for k, v in pairs(fields or {}) do q[k] = v end
  return q
end
local function file(quests, extra)
  local value = {version = 1, revision = 1, quests = quests}
  for k, v in pairs(extra or {}) do value[k] = v end
  setPlay(value)
end
local function events() local value = decode(game.files[Play.EVENTS]); return value end
local function names()
  local list = {}
  for _, e in ipairs(game.files[Play.EVENTS] and events().events or {}) do list[#list + 1] = e.name end
  return table.concat(list, ' ')
end
local function count(name) local n = 0 for _, e in ipairs(events().events) do if e.name == name then n = n + 1 end end return n end
local function pinCount() local n = 0 for _ in pairs(game.pins) do n = n + 1 end return n end
local say = {kind = 'say', text = 'Words.', channel = 'own'}
`;
const reachHarness = `
local Reach = ${load('quest-reach.lua')}
${base}
local game = {now = 0, gameClock = 1000000, rate = 1, enabled = true, busy = false, refreshes = 0, texts = {}, voices = {}, calls = {}, emitted = {}, textOk = true, voiceOk = true,
  callIn = nil, reads = {hour = {14, 30}, weather = 'clear', heat = 0, district = {district = 'Watson', area = 'Watson_Kabuki'}, health = 80, song = {playing = false}, position = {x = 0, y = 0}},
  counts = {}, busyCalls = 0, refreshBlock = nil}
local function reader(name)
  return function()
    game.counts[name] = (game.counts[name] or 0) + 1
    local value = game.reads[name]
    if type(value) == 'function' then return value() end
    if name == 'hour' and type(value) == 'table' then return value[1], value[2] end
    return value
  end
end
local reach
reach = Reach.new({
  enabled = function() return game.enabled end,
  clock = function() return game.now end,
  gameTime = function() return game.gameClock end,
  busy = function() game.busyCalls = game.busyCalls + 1; return game.busy end,
  read = {hour = reader('hour'), weather = reader('weather'), heat = reader('heat'), district = reader('district'), health = reader('health'), song = reader('song'), position = reader('position')},
  text = function(key, text, image) game.texts[#game.texts + 1] = {key = key, text = text, image = image}; return game.textOk end,
  call = function(item) if not game.callIn then return nil end game.calls[#game.calls + 1] = item.id; return game.callIn(item) end,
  voice = function(item) game.voices[#game.voices + 1] = item.text; return game.voiceOk end,
  near = function(key) return game.near == key end,
  emit = function(id) game.emitted[#game.emitted + 1] = id end,
  refresh = function() game.refreshes = game.refreshes + 1; if game.refreshBlock ~= nil then local b = game.refreshBlock; game.refreshBlock = nil; reach.setBlock(b ~= false and b or nil) end end,
  log = log})
local function step(seconds)
  for _ = 1, math.floor(seconds * 10 + 0.5) do
    game.now = game.now + 0.1; game.gameClock = game.gameClock + 0.1 * game.rate
    reach.update()
  end
end
local function item(id, fields)
  local row = {id = id, character = 'panam-palmer', via = 'text', text = 'Hey. ' .. id}
  for k, v in pairs(fields or {}) do row[k] = v end
  return row
end
local function block(items, extra)
  local value = {enabled = true, items = items}
  for k, v in pairs(extra or {}) do value[k] = v end
  return value
end
-- Start the timer with these items and run one tick (60 s of real time).
local function tick(items, extra)
  reach.setBlock(block(items, extra))
  step(60.5)
end
local function delivered() local ids = {} for _, t in ipairs(game.texts) do ids[#ids + 1] = t.text end return table.concat(ids, '|') end
`;
const withGame = code => run(`${harness}
${code}
assert(not game.stale, 'a handle was kept across ticks')`);
const withReach = code => run(`${reachHarness}
${code}`);


test('a quest begun in person leaves its plain text row out while she is near: no text, the row is still done, a log line says why', () => withGame(`
game.near = 'panam-palmer'
file({quest({via = 'own', lines = {['T.1'] = {kind = 'text', text = 'Come out to the Sunset?'}}, script = {{when = 'stage:enter', text = 'T.1'}}})})
play.restore()
assert(#game.phones == 0, 'nothing sent beside V')
assert(count('line:T.1:done') == 1, 'the script still moves on')
assert(logged('left out: she is beside V'))
`));

test('the same quest texts when she is not near, and a quest with no recorded start (an older play file) is treated as in person', () => withGame(`
game.near = nil
file({quest({via = 'own', lines = {['T.1'] = {kind = 'text', text = 'Come out to the Sunset?'}}, script = {{when = 'stage:enter', text = 'T.1'}}})})
play.restore(); assert(#game.phones == 1 and game.phones[1].text == 'Come out to the Sunset?')
`));

test('a quest begun by Phone Chat or a holocall texts even when she is near', () => withGame(`
game.near = 'panam-palmer'
file({quest({via = 'phone', lines = {['T.1'] = {kind = 'text', text = 'Come out to the Sunset?'}}, script = {{when = 'stage:enter', text = 'T.1'}}})})
play.restore(); assert(#game.phones == 1)
`));

test('a picture text is sent even when she is near (the photo is the point), and a wrong via is dropped', () => withGame(`
game.near = 'panam-palmer'
local image = {atlas = 'cyberpunk_convai/phone_images/sun.inkatlas', part = 'sun', width = 10, height = 10}
file({quest({via = 'own', images = {sun = image}, lines = {['T.1'] = {kind = 'text', text = 'Look.'}}, script = {{when = 'stage:enter', text = 'T.1', image = 'sun'}}})})
play.restore(); assert(#game.phones == 1 and game.phones[1].image.part == 'sun')
`));

test('a reach-out of a character who stands beside V waits, and is delivered at a later tick once she is not near', () => withReach(`
game.near = 'panam-palmer'
tick({item('a-one')})
assert(#game.texts == 0, 'beside V: not delivered, got ' .. delivered())
game.near = nil; step(60)
assert(#game.texts == 1 and game.texts[1].text == 'Hey. a-one')
`));

test('a reach-out of someone else is not held back by a neighbour, and Johnny speaking up in V head is never held back', () => withReach(`
game.near = 'judy-alvarez'
tick({item('a-one'), item('j-one', {character = 'johnny-silverhand', via = 'voice', text = 'Hm.'})})
assert(#game.texts == 1 and #game.voices == 0 or #game.texts == 0 and #game.voices == 1, 'one delivery per tick')
game.near = 'johnny-silverhand'; step(3700); step(60)
assert(#game.texts + #game.voices == 2)
`));

test('an older play file with no start recorded is treated as begun in person', () => withGame(`
game.near = 'panam-palmer'
file({quest({lines = {['T.1'] = {kind = 'text', text = 'Come out to the Sunset?'}}, script = {{when = 'stage:enter', text = 'T.1'}}})})
play.restore(); assert(#game.phones == 0 and count('line:T.1:done') == 1)
`));
