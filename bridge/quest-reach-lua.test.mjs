// Characters text first, the game half (mod/quest-reach.lua, docs/QUEST_PRIMITIVES.md section 10.7): the moments (district change, fight end, the 60 s tick), every condition kind
// of bridge/reach-outs.mjs with its extra fields, the caps, the busy refusal, the three delivery paths, the reach event, and the cleanup. Run on a fake game (a clock, a game
// clock, reads that can fail, deliveries that are only recorded). Nothing here starts the game.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run, load, base} from './quest-lua-fixture.mjs';

const harness = `
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
const withGame = code => run(`${harness}\n${code}`);

test('no items, a block that is not enabled and a setting that is off cost a nil check: no timer, no read, no refresh, no busy test', () => withGame(`
step(300)
assert(not reach.active() and game.refreshes == 0 and game.busyCalls == 0)
assert(reach.setBlock(nil) == false and reach.setBlock({enabled = true, items = {}}) == false and not reach.active())
assert(reach.setBlock({enabled = false, items = {item('a')}}) == false and not reach.active(), 'the bridge says the setting is off')
game.enabled = false
assert(reach.setBlock(block({item('a')})) == false and not reach.active(), 'the setting is off here')
step(300); reach.districtChanged(); reach.sample(true); reach.sample(false)
assert(next(game.counts) == nil and game.refreshes == 0 and #game.texts == 0 and game.busyCalls == 0)
`));

test('the tick runs every 60 seconds of real time, refreshes the play file first, and an item with no condition is delivered at the first one', () => withGame(`
reach.setBlock(block({item('a')}))
assert(reach.active())
step(59); assert(game.refreshes == 0 and #game.texts == 0, 'nothing before 60 s')
step(1.5); assert(game.refreshes == 1 and #game.texts == 1 and game.texts[1].key == 'panam-palmer' and game.texts[1].text == 'Hey. a')
assert(game.emitted[1] == 'a')
step(60); assert(game.refreshes == 2, 'the second tick a minute later')
step(60); assert(game.refreshes == 3)
`));

test('weather: the kind, with the words rain (also heavy and toxic rain), dust and sand (sandstorm); an unreadable weather is false', () => withGame(`
game.reads.weather = 'heavy-rain'
tick({item('wet', {when = {kind = 'weather', is = 'rain'}}), item('dry', {when = {kind = 'weather', is = 'clear'}}), item('dusty', {when = {kind = 'weather', is = 'dust'}})})
assert(delivered() == 'Hey. wet')
game.texts = {}; game.gameClock = game.gameClock + 4000; game.reads.weather = 'sandstorm'
step(60.5); assert(delivered() == 'Hey. dusty', delivered())
game.texts = {}; game.gameClock = game.gameClock + 4000; game.reads.weather = nil
step(60.5); assert(delivered() == '', 'unreadable is false')
game.reads.weather = 'clear'; step(60.5); assert(delivered() == 'Hey. dry')
`));

test('hours: a window, a window across midnight, the end hour is out, and the minute counts; unreadable is false', () => withGame(`
local function at(hour, minute, ...)
  reach.reset(); game.texts = {}; game.gameClock = game.gameClock + 9000
  game.reads.hour = hour and {hour, minute} or nil
  tick({...})
  return delivered()
end
local night, noon = item('night', {when = {kind = 'hours', from = 22, to = 5}}), item('noon', {when = {kind = 'hours', from = 12, to = 14}})
assert(at(23, 30, night, noon) == 'Hey. night')
assert(at(4, 59, night, noon) == 'Hey. night', 'before 5:00 still night')
assert(at(5, 0, night, noon) == '', '5:00 is out of 22 to 5')
assert(at(22, 0, night, noon) == 'Hey. night', '22:00 is in')
assert(at(13, 59, night, noon) == 'Hey. noon')
assert(at(14, 0, night, noon) == '', '14:00 is out of 12 to 14')
assert(at(nil, nil, night, noon) == '', 'unreadable')
`));

test('hours.idle: true needs V to stand still between two ticks, a number needs that many game minutes; position is read only while an item asks', () => withGame(`
game.reads.hour = {3, 0}
reach.setBlock(block({item('still', {when = {kind = 'hours', from = 3, to = 5, idle = true}})}))
step(60.5); assert(delivered() == '', 'the first tick only learns where V stands')
game.reads.position = {x = 100, y = 0}; step(60); assert(delivered() == '', 'V moved')
step(60); assert(delivered() == 'Hey. still', delivered())
game.texts = {}; reach.reset()
-- minutes
game.gameClock = game.gameClock + 5000; game.rate = 1
reach.setBlock(block({item('long', {when = {kind = 'hours', from = 3, to = 5, idle = 30}})}))
game.reads.position = {x = 5, y = 5}
step(60.5)   -- anchor set at game time T
step(60); assert(delivered() == '', 'only ~1 game minute still')
game.gameClock = game.gameClock + 1675
step(60); assert(delivered() == '', 'just under 30 game minutes')
step(60); assert(delivered() == 'Hey. long', delivered())
-- an item without idle never reads the position
game.texts, game.counts = {}, {}; reach.reset(); game.gameClock = game.gameClock + 5000
tick({item('plain', {when = {kind = 'hours', from = 3, to = 5}})})
assert(game.counts.position == nil and delivered() == 'Hey. plain')
`));

test('district: V is in it (district, area or a part of an area name), at the district change and at the tick; minutes count from the first sight and never early', () => withGame(`
reach.setBlock(block({item('kabuki', {when = {kind = 'district', is = 'Kabuki'}}), item('city', {when = {kind = 'district', is = 'City Center'}})}))
reach.districtChanged(); assert(delivered() == 'Hey. kabuki', 'area part Kabuki of Watson_Kabuki')
game.texts = {}; game.gameClock = game.gameClock + 4000; game.now = game.now + 10
game.reads.district = {district = 'CityCenter'}
reach.districtChanged(); assert(delivered() == 'Hey. city', 'City Center = CityCenter')
-- unreadable district: false
game.texts = {}; game.gameClock = game.gameClock + 4000; game.now = game.now + 10; game.reads.district = nil
reach.districtChanged(); assert(delivered() == '')
-- dwell
reach.reset(); game.texts = {}; game.reads.district = {district = 'Watson'}; game.gameClock = game.gameClock + 9000
reach.setBlock(block({item('stay', {when = {kind = 'district', is = 'Watson', minutes = 5}})}))
reach.districtChanged(); assert(delivered() == '', 'just arrived')
game.gameClock = game.gameClock + 4 * 60; game.now = game.now + 10; reach.districtChanged(); assert(delivered() == '', '4 minutes')
game.gameClock = game.gameClock + 90; game.now = game.now + 10; reach.districtChanged(); assert(delivered() == 'Hey. stay', delivered())
`));

test('district dwell restarts when V goes to another district', () => withGame(`
reach.setBlock(block({item('stay', {when = {kind = 'district', is = 'Watson', minutes = 5}})}))
reach.districtChanged()
game.gameClock = game.gameClock + 4 * 60; game.now = game.now + 10
game.reads.district = {district = 'Heywood'}; reach.districtChanged()
game.gameClock = game.gameClock + 2 * 60; game.now = game.now + 10
game.reads.district = {district = 'Watson'}; reach.districtChanged(); assert(delivered() == '', 'back in Watson for no time')
game.gameClock = game.gameClock + 6 * 60; game.now = game.now + 10; reach.districtChanged(); assert(delivered() == 'Hey. stay')
`));

test('district changes are looked at once per 5 seconds at most', () => withGame(`
reach.setBlock(block({item('a', {when = {kind = 'district', is = 'Heywood'}})}))
for _ = 1, 20 do reach.districtChanged() end
assert(game.counts.district == 1, 'one read for a burst: ' .. tostring(game.counts.district))
game.now = game.now + 5.1; reach.districtChanged(); assert(game.counts.district == 2)
`));

test('fight-end: health below, heat at least and district are all read at the end of the fight; a missing read is false; other moments do not make it true', () => withGame(`
reach.setBlock(block({item('hurt', {when = {kind = 'fight-end', healthBelow = 25}}), item('hot', {when = {kind = 'fight-end', heatAtLeast = 3}}),
  item('here', {when = {kind = 'fight-end', district = 'Watson'}})}))
step(30); reach.sample(false); assert(delivered() == '', 'no fight ended yet')
reach.sample(true)
game.reads.health, game.reads.heat = 60, 1
reach.sample(false); assert(delivered() == 'Hey. here', 'health 60 is not below 25, heat 1 is not 3, the district is Watson: ' .. delivered())
-- hurt and hot
game.texts = {}; game.gameClock = game.gameClock + 4000
reach.sample(true); game.reads.health, game.reads.heat = 10, 4; reach.sample(false)
assert(delivered() == 'Hey. hurt', 'the first listed item whose condition holds, one per hour: ' .. delivered())
game.texts = {}; game.gameClock = game.gameClock + 4000
reach.sample(true); game.reads.health, game.reads.heat = 50, 4; reach.sample(false)
assert(delivered() == 'Hey. hot', delivered())
-- unreadable health: healthBelow is false
reach.reset(); game.texts = {}; game.gameClock = game.gameClock + 9000
reach.setBlock(block({item('hurt', {when = {kind = 'fight-end', healthBelow = 25}})}))
game.reads.health = nil; reach.sample(true); reach.sample(false); assert(delivered() == '')
`));

test('fight-end together: all given fields must hold (district and heat)', () => withGame(`
reach.setBlock(block({item('both', {when = {kind = 'fight-end', district = 'Heywood', heatAtLeast = 2}})}))
game.reads.heat = 3
reach.sample(true); reach.sample(false); assert(delivered() == '', 'Watson is not Heywood')
game.reads.district = {district = 'Heywood'}; game.gameClock = game.gameClock + 10
reach.sample(true); reach.sample(false); assert(delivered() == 'Hey. both')
`));

test('a fight end refused as busy is tried again at the ticks for 120 seconds with the snapshot, then dropped', () => withGame(`
reach.setBlock(block({item('hurt', {when = {kind = 'fight-end', healthBelow = 25}})}))
step(20)
game.reads.health = 10; game.busy = true
reach.sample(true); reach.sample(false); assert(delivered() == '' and game.busyCalls == 1, 'busy')
game.reads.health = 90   -- healed since: the snapshot still says 10
game.busy = false
step(41); assert(delivered() == 'Hey. hurt', 'the tick delivers it from the snapshot: ' .. delivered())
-- too late
reach.reset(); game.texts = {}; game.gameClock = game.gameClock + 9000
reach.setBlock(block({item('hurt', {when = {kind = 'fight-end', healthBelow = 25}})}))
game.reads.health = 10; game.busy = true; reach.sample(true); reach.sample(false)
step(125); game.busy = false
step(60); assert(delivered() == '', 'the snapshot is gone after 120 s')
`));

test('heat: the stage at least; unreadable is false', () => withGame(`
game.reads.heat = 2
tick({item('h4', {when = {kind = 'heat', atLeast = 4}}), item('h2', {when = {kind = 'heat', atLeast = 2}})})
assert(delivered() == 'Hey. h2')
game.texts = {}; game.gameClock = game.gameClock + 4000; game.reads.heat = nil; step(60.5); assert(delivered() == '')
game.reads.heat = 5; step(60.5); assert(delivered() == 'Hey. h4' or delivered() == 'Hey. h2')
`));

test('song: something playing, with the text in the song or the station (case-insensitive); silence and unreadable are false', () => withGame(`
game.reads.song = {playing = false}
tick({item('any', {when = {kind = 'song'}}), item('named', {when = {kind = 'song', contains = 'samurai'}})})
assert(delivered() == '', 'silence')
game.reads.song = {playing = true, station = 'Radio Pebkac', song = 'Chippin In'}
game.gameClock = game.gameClock + 4000; step(60.5); assert(delivered() == 'Hey. any', delivered())
game.texts = {}; reach.reset(); game.gameClock = game.gameClock + 9000
game.reads.song = {playing = true, station = 'Radio', song = 'SAMURAI Never Fade Away'}
tick({item('named', {when = {kind = 'song', contains = 'samurai'}})}); assert(delivered() == 'Hey. named')
game.texts = {}; reach.reset(); game.gameClock = game.gameClock + 9000; game.reads.song = nil
tick({item('any', {when = {kind = 'song'}})}); assert(delivered() == '')
`));

test('an unknown condition kind or a malformed condition is false, never silently true', () => withGame(`
tick({item('odd', {when = {kind = 'moon'}}), item('bad', {when = {kind = 'hours', from = 5, to = 5}}), item('str', {when = 'now'})})
assert(delivered() == '')
`));

test('caps: one delivery per game hour and three per game day by default, the bridge numbers when given, nothing without a game clock', () => withGame(`
reach.setBlock(block({item('a'), item('b'), item('c'), item('d'), item('e')}))
step(60.5); assert(delivered() == 'Hey. a')
step(60); assert(delivered() == 'Hey. a', 'still the same game hour')
game.gameClock = game.gameClock + 3700; step(60); assert(delivered() == 'Hey. a|Hey. b')
game.gameClock = game.gameClock + 3700; step(60); assert(delivered() == 'Hey. a|Hey. b|Hey. c')
game.gameClock = game.gameClock + 3700; step(60); assert(delivered() == 'Hey. a|Hey. b|Hey. c', 'three per day')
game.gameClock = game.gameClock + 86400; step(60); assert(delivered():match('Hey. d$'), delivered())
-- the bridge's numbers
reach.reset(); game.texts = {}
reach.setBlock(block({item('a'), item('b'), item('c')}, {perHour = 2, perDay = 2}))
step(60.5); step(60); assert(delivered() == 'Hey. a|Hey. b', 'two in the same hour')
game.gameClock = game.gameClock + 3700; step(60); assert(delivered() == 'Hey. a|Hey. b', 'two a day')
`));

test('caps need the game clock: without one nothing is delivered; a stamp later than the clock is dropped', () => withGame(`
local saved = game.gameClock
reach.setBlock(block({item('a')}))
local hold = Reach.new  -- keep the module
game.gameClock = nil
local r2 = Reach.new({enabled = function() return true end, clock = function() return game.now end, gameTime = function() return game.gameClock end, busy = function() return false end,
  text = function() game.texts[#game.texts + 1] = {} return true end, log = log})
r2.setBlock(block({item('a')})); game.now = game.now + 61; r2.update()
assert(#game.texts == 0, 'no game clock, no delivery')
game.gameClock = saved
game.now = game.now + 61; r2.update(); assert(#game.texts == 1)
-- the save was reloaded to an earlier time: the stamp is in the future and dropped
reach.reset(); game.texts = {}; game.gameClock = 5000
reach.setBlock(block({item('b'), item('c')}))
game.now = game.now + 61; reach.update(); assert(delivered() == 'Hey. b')
game.gameClock = 100; game.now = game.now + 61; reach.update()
assert(delivered() == 'Hey. b|Hey. c', 'a stamp from the future does not block')
`));

test('busy refusal: nothing is delivered while the line player would be refused, and it is delivered once the game is free; no busy test without a matching item', () => withGame(`
game.busy = true
reach.setBlock(block({item('a'), item('z', {when = {kind = 'weather', is = 'fog'}})}))
step(60.5); assert(delivered() == '' and game.busyCalls == 1)
step(60); assert(delivered() == '' and game.busyCalls == 2)
game.busy = false; step(60); assert(delivered() == 'Hey. a' and game.busyCalls == 3)
-- nothing matches: the busy test is not even asked
reach.reset(); game.busyCalls = 0; game.texts = {}; game.gameClock = game.gameClock + 9000
tick({item('z', {when = {kind = 'weather', is = 'fog'}})}); assert(game.busyCalls == 0)
`));

test('a busy test that raises is a refusal', () => withGame(`
local r = Reach.new({enabled = function() return true end, clock = function() return game.now end, gameTime = function() return game.gameClock end,
  busy = function() error('boom') end, text = function() game.texts[#game.texts + 1] = {} return true end, log = log})
r.setBlock(block({item('a')})); game.now = game.now + 61; r.update()
assert(#game.texts == 0)
`));

test('delivery by text carries the picture key; a delivery the game could not make is not counted and is tried again', () => withGame(`
game.textOk = false
tick({item('pic', {image = 'card-wide'})})
assert(#game.texts == 1 and game.texts[1].image == 'card-wide' and #game.emitted == 0, 'tried, not delivered, no event')
game.textOk = true; step(60); assert(#game.texts == 2 and game.emitted[1] == 'pic')
step(240); assert(#game.texts == 2, 'delivered ids are not delivered again while the block lists them')
`));

test('delivery by call: the call system when it is there (nil answer = absent), the item text as a text when it is not, nothing when it refuses', () => withGame(`
tick({item('ring', {via = 'call', text = 'Pick up.'})})
assert(delivered() == 'Pick up.' and #game.calls == 0, 'no call system, the text goes: ' .. delivered())
reach.reset(); game.texts, game.emitted = {}, {}; game.gameClock = game.gameClock + 9000
game.callIn = function() return true end
tick({item('ring', {via = 'call', text = 'Pick up.'})})
assert(#game.texts == 0 and game.calls[1] == 'ring' and game.emitted[1] == 'ring', 'the call system took it')
reach.reset(); game.emitted = {}; game.gameClock = game.gameClock + 9000
game.callIn = function() return false end
tick({item('ring', {via = 'call', text = 'Pick up.'})})
assert(#game.texts == 0 and #game.emitted == 0, 'the call system refused: no text, tried again later')
`));

test('delivery by voice: Johnny in the head of V through the voice path, a refusal there is not a delivery', () => withGame(`
game.voiceOk = false
tick({item('jr', {via = 'voice', character = 'johnny-silverhand', text = 'Hey, V.'})})
assert(#game.voices == 1 and #game.texts == 0 and #game.emitted == 0)
game.voiceOk = true; step(60); assert(#game.voices == 2 and game.voices[2] == 'Hey, V.' and game.emitted[1] == 'jr')
`));

test('the reach event is raised once per delivery with the item id', () => withGame(`
tick({item('a'), item('b')})
assert(#game.emitted == 1 and game.emitted[1] == 'a')
game.gameClock = game.gameClock + 3700; step(60); assert(#game.emitted == 2 and game.emitted[2] == 'b')
`));

test('a new block keeps the delivered ids it still lists and forgets the ones it dropped; an item the bridge lists again later can be delivered again', () => withGame(`
tick({item('a'), item('b')})
assert(delivered() == 'Hey. a')
reach.setBlock(block({item('a'), item('b'), item('c')}))   -- the bridge has not noticed yet
game.gameClock = game.gameClock + 3700; step(60); assert(delivered() == 'Hey. a|Hey. b', 'a is not repeated')
reach.setBlock(block({item('c')}))   -- a and b are gone
game.gameClock = game.gameClock + 3700; reach.setBlock(block({item('a'), item('c')})); game.gameClock = game.gameClock + 100
step(60); assert(delivered() == 'Hey. a|Hey. b|Hey. a', 'a is listed again: ' .. delivered())
`));

test('the play file is read before each tick and a block that empties out stops the timer', () => withGame(`
reach.setBlock(block({item('a', {when = {kind = 'weather', is = 'fog'}})}))
game.refreshBlock = false   -- the refreshed play file has no reach block any more
step(60.5)
assert(game.refreshes == 1 and not reach.active() and game.busyCalls == 0)
step(300); assert(game.refreshes == 1, 'no more ticks')
`));

test('a refreshed block with new items is used by the same tick', () => withGame(`
reach.setBlock(block({item('a', {when = {kind = 'weather', is = 'fog'}})}))
game.refreshBlock = block({item('fresh')})
step(60.5); assert(delivered() == 'Hey. fresh', delivered())
`));

test('setting off: the timer is cancelled at the next look (within a second) and nothing is delivered', () => withGame(`
reach.setBlock(block({item('a')}))
step(30); game.enabled = false; step(2)
assert(not reach.active(), 'cancelled')
game.enabled = true; step(120); assert(delivered() == '' and game.refreshes == 0)
assert(reach.setBlock(block({item('a')})) == true and reach.active(), 'switching it on again with a block starts a new timer')
`));

test('the setting is checked again at the moment of a delivery', () => withGame(`
reach.setBlock(block({item('a', {when = {kind = 'district', is = 'Watson'}})}))
game.enabled = false; reach.districtChanged()
assert(delivered() == '' and not reach.active())
`));

test('world change: reset drops the timer, the snapshots, the delivered ids and the fired stamps', () => withGame(`
tick({item('a')})
assert(delivered() == 'Hey. a')
reach.reset('world')
assert(not reach.active() and reach.status().stamps == 0 and reach.status().delivered == 0)
step(300); assert(game.refreshes == 1)
-- a fresh block works at once (the stamps went with the world)
reach.setBlock(block({item('a')})); step(60.5); assert(delivered() == 'Hey. a|Hey. a')
`));

test('the module keeps no handle: a read that returns a table is read again at every use', () => withGame(`
local seen = {}
game.reads.district = function() local t = {district = 'Watson'}; seen[#seen + 1] = t; return t end
reach.setBlock(block({item('a', {when = {kind = 'district', is = 'Heywood'}})}))
reach.districtChanged(); game.now = game.now + 6; reach.districtChanged()
assert(#seen == 2 and seen[1] ~= seen[2])
`));

test('status reports the timer, the items, the stamps and the caps', () => withGame(`
reach.setBlock(block({item('a'), item('b')}, {perHour = 2}))
local s = reach.status()
assert(s.running and s.items == 2 and s.perHour == 2 and s.perDay == 3 and s.stamps == 0 and s.delivered == 0 and s.nextTickIn > 59)
`));
