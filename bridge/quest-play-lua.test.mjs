// The executor of the bond quests, the game half (mod/quest-play.lua, docs/QUEST_PRIMITIVES.md): the play file, the ctx that owns every spawn, pin and timer of a stage,
// the script rows, the events file and the bridge's commands. Run on a fake game (a clock, files in memory, a world of positions whose rows die at every tick),
// with the real places, line player and primitives behind it. Nothing here starts the game.
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
  present = function(key) if game.absent then return false end return nil end,
  start = function(entry) if game.startFail then return nil, game.startFail end local id = 'r' .. game.nextRequest; game.nextRequest = game.nextRequest + 1; game.started[#game.started + 1] = entry; return id end,
  subtitle = function(key, text) game.subtitles[#game.subtitles + 1] = text end,
  phone = function(key, text, image) game.phones[#game.phones + 1] = {key = key, text = text, image = image}; return true end,
  emit = function(pack, name) play.emitPack(pack, name) end,
  onChange = function() play.rearm() end})
play = Play.new({
  enabled = function() return game.enabled end, clock = clock, gameTime = function() return game.gameClock end,
  read = function(path) game.reads = game.reads + 1; return game.files[path] end,
  write = function(path, text) if game.writeFails then return false end game.files[path] = text; game.writes = game.writes + 1; return true end,
  encode = serialize, decode = function(text) game.decodes = game.decodes + 1; return decode(text) end,
  places = places, lines = lines, prims = prims, session = 'sess1', log = log})
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
const withGame = code => run(`${harness}\n${code}\nassert(not game.stale, 'a handle was kept across ticks')`);

test('nothing armed costs a nil check: no read, no write, no call into the game, over minutes of ticks', () => withGame(`
step(120)
assert(game.reads == 0 and game.writes == 0 and game.decodes == 0)
-- Restored with no file and no quest: still nothing per tick afterwards.
assert(play.restore() == false)
local reads = game.reads
step(120); assert(game.reads == reads and game.writes == 0 and not play.armed())
-- A file with no quest in it.
file({}); play.onPlayRevision(); reads = game.reads
step(60); assert(game.reads == reads and not play.armed())
`));

test('restore reads the play file once, arms the stage, reports stage:enter with the session and a seq, and the stage rows answer it', () => withGame(`
file({quest({script = {{when = 'stage:enter', say = 'P1.walk.02'}}, lines = {['P1.walk.02'] = say}})})
assert(play.restore() == true and play.armed())
local value = events()
assert(value.version == 1 and value.session == 'sess1' and value.seq == 1 and #value.events == 1)
local e = value.events[1]
assert(e.seq == 1 and e.pack == 'panam-sunset-coffee' and e.serial == 1 and e.name == 'stage:enter' and e.at == 100000, e.name)
assert(#game.started == 1 and game.started[1].id == 'P1.walk.02' and game.started[1].profileKey == 'panam-palmer')
`));

test('while armed the file is read once a second and decoded only when it changed', () => withGame(`
file({quest({})}); play.restore()
local reads, decodes = game.reads, game.decodes
step(60)
assert(game.reads - reads >= 59 and game.reads - reads <= 61, 'about 1 Hz: ' .. (game.reads - reads))
assert(game.decodes == decodes, 'an unchanged file is not decoded again')
file({quest({}), quest({pack = 'judy-spare-parts', character = 'judy-alvarez'})}); step(1.1)
assert(game.decodes == decodes + 1 and play.quest('judy-spare-parts') ~= nil)
`));

test('a quest stamped later than the loaded save clock plus 120 s belongs to a save that was loaded away from: ignored', () => withGame(`
file({quest({since = 100000 + 121})}); play.restore()
assert(not play.armed() and play.quest('panam-sunset-coffee') == nil and game.files[Play.EVENTS] == nil and logged('stamped later than this save'))
file({quest({since = 100000 + 120})}); play.onPlayRevision()
assert(play.quest('panam-sunset-coffee') ~= nil, 'the slack is 120 s')
-- The same quest, later rolled back by a load: ignored again and reaped.
file({quest({since = 100000 + 900, serial = 2})}); step(1.2)
assert(play.quest('panam-sunset-coffee') == nil and not play.armed())
`));

test('the setting off reaps everything of every quest, stops the reads and costs nothing after', () => withGame(`
file({quest({['do'] = {{p = 'pin', at = 'sunset'}, {p = 'place', at = 'sunset'}, {p = 'timer', id = 't', seconds = 60}}})})
play.restore(); step(2)
assert(pinCount() == 1 and places.active())
game.enabled = false; step(1.2)
assert(pinCount() == 0 and not places.active() and play.quest('panam-sunset-coffee') == nil and not play.armed())
local reads = game.reads; step(30); assert(game.reads == reads)
game.enabled = true; assert(play.restore() == true and pinCount() == 1, 'turned on again')
game.enabled = false; assert(play.restore() == false)
`));

test('a stage change reaps the old stage (pin, watch, timers, cast) and starts the new one, which reports stage:enter once for its serial', () => withGame(`
file({quest({['do'] = {{p = 'pin', at = 'sunset'}, {p = 'place', at = 'sunset'}, {p = 'cast', id = 'tom', who = 'extra', record = 'Character.Generic', at = 'sunset'}}})})
play.restore(); game.vpos = {x = 100, y = 260, z = 10}; step(3)
assert(pinCount() == 1 and #game.spawnCalls == 1 and play.status().quests[1].tracked >= 3)
-- The same stage and serial again (the file was rewritten): nothing restarts.
file({quest({['do'] = {{p = 'pin', at = 'sunset'}, {p = 'place', at = 'sunset'}, {p = 'cast', id = 'tom', who = 'extra', record = 'Character.Generic', at = 'sunset'}}})}, {revision = 2})
step(2); assert(game.pinAdds == 1 and #game.spawnCalls == 1 and game.pinRemoves == 0 and count('stage:enter') == 1)
-- The next stage.
file({quest({stage = 'sit', serial = 2, ['do'] = {}})}, {revision = 3}); step(1.2)
assert(pinCount() == 0 and not places.active() and #game.deleted == 1 and game.deleted[1] == 'h1', 'the old stage is gone')
assert(play.status().quests[1].stage == 'sit' and play.status().quests[1].tracked == 0)
local e = events().events; assert(e[#e].name == 'stage:enter' and e[#e].serial == 2)
-- Old stage events do not come back.
game.vpos = {x = 100, y = 200, z = 10}; step(5); assert(count('place:sunset:arrived') == 0)
`));

test('a quest that leaves the file is reaped, and the module goes quiet', () => withGame(`
file({quest({['do'] = {{p = 'pin', at = 'sunset'}}})}); play.restore()
assert(pinCount() == 1)
file({}, {revision = 2}); step(1.2)
assert(pinCount() == 0 and not play.armed())
local reads = game.reads; step(30); assert(game.reads == reads, 'nothing is read once nothing is armed')
-- The file vanishing (the bridge cleaned it up) is the same.
file({quest({['do'] = {{p = 'pin', at = 'sunset'}}})}, {revision = 3}); play.onPlayRevision(); assert(pinCount() == 1)
game.files[Play.PLAY] = nil; step(1.2); assert(pinCount() == 0 and not play.armed())
`));

test('events: the file is rewritten only when an event was added, with the last 32 and a growing seq', () => withGame(`
file({quest({})}); play.restore()
local writes = game.writes
step(30); assert(game.writes == writes, 'idle ticks write nothing')
for i = 1, 40 do play.inject('probe:e' .. i) end
local value = events()
assert(value.seq == 41 and #value.events == 32 and value.events[1].seq == 10 and value.events[32].seq == 41 and value.events[32].name == 'probe:e40', value.events[1].seq)
assert(game.writes == writes + 40, 'one write per event: ' .. (game.writes - writes))
assert(play.inject('Bad Name!') == 0 and play.inject('') == 0 and game.writes == writes + 40)
-- A write that fails is tried again on the next step.
game.writeFails = true; play.inject('probe:late'); local failed = game.writes
step(2); assert(game.writes == failed)
game.writeFails = false; step(2); assert(game.writes == failed + 1 and count('probe:late') == 1)
`));

test('an events file that can never be written is given up after twenty tries and the module goes quiet again', () => withGame(`
file({quest({})}); play.restore()
game.writeFails = true
play.inject('probe:a')
step(30)
assert(logged('events file cannot be written'))
file({}, {revision = 2}); step(2)
assert(not play.armed(), 'nothing keeps it awake')
`));

test('rows fire once per stage visit in file order, chained events are handled in turn, a loop is cut, and a new visit fires them again', () => withGame(`
local rows = {
  {when = 'stage:enter', event = 'one'},
  {when = 'one', say = 'L.a'}, {when = 'one', event = 'two'},
  {when = 'two', say = 'L.b'},
  {when = 'ping', event = 'pong'}, {when = 'pong', event = 'ping'},
}
local function stage(serial) return quest({serial = serial, script = rows, lines = {['L.a'] = say, ['L.b'] = say}}) end
file({stage(1)}); play.restore()
assert(names() == 'stage:enter one two', names())
assert(#game.started == 1 and game.started[1].id == 'L.a', 'L.a is on the air, L.b waits behind it')
play.inject('one'); assert(names() == 'stage:enter one two one', 'the event is reported again, its rows do not fire again')
assert(lines.status().waiting[1] == nil or #lines.status().waiting <= 1)
play.inject('ping'); assert(names():find('ping pong ping', 1, true) and count('ping') == 2 and count('pong') == 1, names())
-- A new visit of the stage (a new serial): the rows are fresh.
file({stage(2)}, {revision = 2}); step(1.2)
assert(count('two') == 2 and count('one') == 3, 'the second visit fires its rows again')
`));

test('the commands of the bridge are acted on once per seq, for the right serial, and the game does not report them back', () => withGame(`
local gaps = {g1 = {resumeAfterSeconds = 9999}}
local q = quest({gaps = gaps, script = {{when = 'stage:enter', gap = 'g1'}, {when = 'gap:g1:shared', event = 'some:follow-on'}}})
file({q}); play.restore()
assert(names() == 'stage:enter gap:g1:open' and lines.gapOpen())
local command = {seq = 5, pack = 'panam-sunset-coffee', serial = 1, cmd = 'event', name = 'gap:g1:shared'}
file({q}, {commands = {command}, revision = 2}); step(1.2)
assert(not lines.gapOpen(), 'the gap ended by the tag the bridge read')
assert(names() == 'stage:enter gap:g1:open some:follow-on', 'the follow-on is reported, the bridge\\'s own event is not: ' .. names())
-- The same file read again, and the same seq in a later file: nothing more.
file({q}, {commands = {command}, revision = 3}); step(1.2)
file({q}, {commands = {command, {seq = 6, pack = 'panam-sunset-coffee', serial = 0, cmd = 'event', name = 'old:stage'}, {seq = 7, pack = 'other', serial = 1, cmd = 'event', name = 'x'},
  {seq = 8, pack = 'panam-sunset-coffee', serial = 1, cmd = 'nonsense'}, {seq = 9, pack = 'panam-sunset-coffee', serial = 1, cmd = 'event', name = 'Bad Name!'}}, revision = 4}); step(1.2)
assert(names() == 'stage:enter gap:g1:open some:follow-on', names())
-- A resume command ends a gap.
file({q}, {commands = {{seq = 10, pack = 'panam-sunset-coffee', serial = 1, cmd = 'event', name = 'tick'}}, revision = 5}); step(1.2)
lines.openGap('panam-sunset-coffee', 'g1'); assert(lines.gapOpen())
file({q}, {commands = {{seq = 11, pack = 'panam-sunset-coffee', serial = 1, cmd = 'resume', gap = 'g1'}}, revision = 6}); step(1.2)
assert(not lines.gapOpen() and count('gap:g1:resume') == 1)
`));

test('commands already in the file when the game starts are old news: not acted on', () => withGame(`
local q = quest({gaps = {g1 = {}}, script = {{when = 'stage:enter', gap = 'g1'}}})
file({q}, {commands = {{seq = 1, pack = 'panam-sunset-coffee', serial = 1, cmd = 'event', name = 'gap:g1:shared'}}})
play.restore()
assert(lines.gapOpen() and names() == 'stage:enter gap:g1:open')
`));

test('an ending runs its rows once when it appears, not for an ending that was already in the file when the game started, and its lines still report', () => withGame(`
local ending = {pack = 'panam-sunset-coffee', character = 'panam-palmer', ending = 'left', serial = 4, lines = {['P1.left.01'] = say},
  script = {{when = 'ending:left', say = 'P1.left.01'}, {when = 'ending:other', say = 'P1.left.01'}}}
file({}, {closing = {ending}}); play.restore()
assert(#game.started == 0, 'an old ending is not played at the start')
file({}, {closing = {{pack = 'panam-sunset-coffee', character = 'panam-palmer', ending = 'repaid', serial = 5, lines = {['P1.r'] = say},
  script = {{when = 'ending:repaid', say = 'P1.r'}}}}, revision = 2})
play.onPlayRevision(); assert(#game.started == 1 and game.started[1].id == 'P1.r')
play.onPlayRevision(); step(3); assert(#game.started == 1, 'once')
local e = events().events; assert(e[#e].name == 'ending:repaid' and e[#e].serial == 5)
-- Its line finishing is told with the ending's serial although the quest is gone.
lines.stopped('r1', 'finished'); e = events().events
assert(e[#e].name == 'line:P1.r:done' and e[#e].serial == 5, e[#e].name)
`));

test('a gap open at a save is restored from the file without a new gap:open event, and ends by its own timer from the stamp', () => withGame(`
local q = quest({gaps = {g1 = {resumeAfterSeconds = 600}}, gap = {id = 'g1', openedAt = 100000 - 595}})
file({q}); play.restore()
assert(lines.gapOpen() and not names():find('gap:g1:open', 1, true))
game.rate = 100; step(1.2)
assert(not lines.gapOpen() and count('gap:g1:resume') == 1)
`));

test('a place, a pin and a row: arrival takes the pin away, is reported, and its row answers; a text row reaches the phone with its picture', () => withGame(`
local image = {atlas = 'cyberpunk_convai\\\\phone_images\\\\sun.inkatlas', part = 'sun', width = 10, height = 10}
file({quest({['do'] = {{p = 'pin', at = 'sunset'}, {p = 'place', at = 'sunset'}}, images = {sun = image},
  lines = {['T.1'] = {kind = 'text', text = 'Look at this sky.'}}, script = {{when = 'place:sunset:arrived', text = 'T.1', image = 'sun'}}})})
play.restore(); assert(pinCount() == 1)
step(3); assert(pinCount() == 1 and count('place:sunset:arrived') == 0)
game.vpos = {x = 100, y = 200, z = 10}; step(2)
assert(pinCount() == 0 and count('place:sunset:arrived') == 1)
assert(#game.phones == 1 and game.phones[1].text == 'Look at this sky.' and game.phones[1].image.part == 'sun')
assert(count('line:T.1:done') == 1)
`));

test('a timer primitive and a together primitive end up as events and rows', () => withGame(`
game.rate = 10
file({quest({['do'] = {{p = 'timer', id = 'wait', seconds = 120}, {p = 'together', id = 'tour', minutes = 5}}, script = {{when = 'timer:wait', event = 'go'}, {when = 'together:tour:done', event = 'walked'}}})})
play.restore()
game.copy = {profileKey = 'panam-palmer', kind = 'party', position = {x = 1, y = 1, z = 0}}
step(8); assert(count('timer:wait') == 0)
step(10); assert(count('timer:wait') == 1 and count('go') == 1, names())
step(40); assert(count('together:tour:done') == 1 and count('walked') == 1, names())
`));

test('a world change forgets the pins without asking the system and the stage registers them again from the saved stage', () => withGame(`
file({quest({['do'] = {{p = 'pin', at = 'sunset'}, {p = 'cast', id = 'tom', who = 'extra', record = 'Character.X', at = 'sunset'}}})})
play.restore(); game.vpos = {x = 100, y = 220, z = 10}; step(3)
assert(game.pinAdds == 1 and #game.spawnCalls == 1)
play.abandon()
assert(game.pinRemoves == 0 and #game.deleted == 0, 'the dead world is not asked anything')
assert(not play.armed() and play.quest('panam-sunset-coffee') == nil)
local reads = game.reads; step(10); assert(game.reads == reads)
play.restore()
assert(game.pinAdds == 2 and play.quest('panam-sunset-coffee') ~= nil, 'registered again')
play.worldChanged(); assert(game.pinRemoves == 0 and game.pinAdds == 3)
-- A stage reaped later removes the new pin with the new handle.
file({}, {revision = 9}); step(1.2); assert(game.pinRemoves == 1)
`));

test('bad files: a wrong version, garbage, an oversize file, a quest with a bad name and more than eight quests are ignored without a crash', () => withGame(`
for _, bad in ipairs({'not a table (', '', string.rep('x', 300000), serialize({version = 2, quests = {quest({})}}), serialize({version = 1, quests = 'no'})}) do
  game.files[Play.PLAY] = bad; assert(play.restore() == false)
end
file({quest({pack = 'Bad Pack'}), quest({character = 'Bad Character'}), quest({stage = ''}), quest({serial = -1}), quest({serial = 1.5}), 'junk', 7})
play.restore(); assert(not play.armed())
local many = {}
for i = 1, 12 do many[i] = quest({pack = 'pack-' .. i}) end
file(many); play.restore()
local n = 0 for i = 1, 12 do if play.quest('pack-' .. i) then n = n + 1 end end
assert(n == 8, n)
`));

test('a primitive that keeps failing is stopped after three failures and logged once; an unknown primitive and a failing arm do not stop the stage', () => withGame(`
local calls = 0
prims.defs.boom = {interval = 1, arm = function() return {} end, tick = function() calls = calls + 1; error('boom') end}
prims.defs.broken = {arm = function() error('cannot start') end}
file({quest({['do'] = {{p = 'boom'}, {p = 'broken'}, {p = 'nonsense'}, {p = 'pin', at = 'sunset'}}})}); play.restore()
step(10)
assert(calls == 3, calls)
assert(logged('primitive boom failed') and logged('primitive broken could not start') and logged('unknown primitive nonsense'))
assert(pinCount() == 1 and play.quest('panam-sunset-coffee') ~= nil, 'the rest of the stage is armed')
`));

test('the ctx: track, after, every, on, untrack and reap are LIFO and idempotent, a reaped ctx ignores its late calls', () => withGame(`
file({quest({})}); play.restore()
local ctx = play.quest('panam-sunset-coffee').ctx
local order = {}
ctx:track('a', 'one', function(h) order[#order + 1] = h end)
ctx:track('b', 'two', function(h) order[#order + 1] = h end)
local third = ctx:track('c', 'three', function(h) order[#order + 1] = h end)
assert(ctx:untrack('three', false) and not ctx:untrack('three'), 'untrack without running the undo')
local fired, repeated, heard = 0, 0, 0
ctx:after(5, function() fired = fired + 1 end)
local every = ctx:every(2, function() repeated = repeated + 1 end)
ctx:on('probe:x', function() heard = heard + 1 end)
step(2.2); assert(repeated == 1)
step(2); assert(repeated == 2 and fired == 0)
play.inject('probe:x'); assert(heard == 1)
step(1); assert(fired == 1); step(5); assert(fired == 1, 'after fires once')
ctx:cancel(every); local seen = repeated; step(6); assert(repeated == seen)
assert(ctx:reap() == true and table.concat(order, ',') == 'two,one', 'LIFO: ' .. table.concat(order, ','))
assert(ctx:reap() == false and #order == 2, 'idempotent')
ctx:emit('probe:late'); play.inject('probe:y'); assert(heard == 1)
assert(ctx:after(1, function() end) == nil and ctx:on('x', function() end) == nil)
local undone = false
ctx:track('late', 'x', function() undone = true end); assert(undone, 'a handle tracked after the reap is released at once')
`));

test('the quest names no other mod and keeps to plain Lua 5.1 with no semicolon in a comment', () => {
  const text = source('quest-play.lua');
  assert.ok(!/\bgoto\b|table\.unpack|bit32/.test(text));
  for (const line of text.split('\n')) assert.ok(!/--.*;/.test(line), 'no semicolon in a comment: ' + line);
});

// ---- reach-outs: the block, the event and the clock of the events file ---------------------------------------------------------------------------------------
test('reach: the block of the play file is cleaned and handed over with each applied file, kept for P.reach(), and gone with the file or the world', () => withGame(`
local handed = {}
local p = Play.new({enabled = function() return game.enabled end, clock = clock, gameTime = function() return game.gameClock end,
  read = function(path) game.reads = game.reads + 1; return game.files[path] end, write = function(path, text) game.files[path] = text; return true end,
  encode = serialize, decode = decode, places = places, lines = lines, prims = prims, session = 'sess2', log = log,
  onReach = function(block) handed[#handed + 1] = block or false end})
assert(p.reach() == nil)
local good = {id = 'pr-bond5', character = 'panam-palmer', via = 'text', text = 'Hey.', image = 'card-wide', when = {kind = 'district', is = 'Watson', minutes = 5, junk = {1}}}
file({}, {reach = {enabled = true, perHour = 1, perDay = 3, items = {good,
  {id = 'Bad Id', character = 'panam-palmer', via = 'text', text = 'x'}, {id = 'no-via', character = 'panam-palmer', via = 'sms', text = 'x'},
  {id = 'no-text', character = 'panam-palmer', via = 'text', text = ''}, {id = 'pr-bond5', character = 'panam-palmer', via = 'text', text = 'twice'},
  {id = 'bad-who', character = 'Not A Key', via = 'text', text = 'x'}, 'junk', {id = 'voice-one', character = 'johnny-silverhand', via = 'voice', text = 'V.', offer = 'hangout-a'}}}})
p.restore()
local block = p.reach()
assert(block and block.enabled == true and #block.items == 2 and block.perHour == 1 and block.perDay == 3, 'two good items')
assert(block.items[1].id == 'pr-bond5' and block.items[1].image == 'card-wide' and block.items[1].when.kind == 'district' and block.items[1].when.minutes == 5 and block.items[1].when.junk == nil)
assert(block.items[2].id == 'voice-one' and block.items[2].offer == 'hangout-a')
assert(#handed == 1 and handed[1] == block, 'handed over once with the file')
-- An empty list, no block, a block that is not a table: nothing.
for _, bad in ipairs({{items = {}}, 'x', {enabled = true}}) do file({}, {reach = bad}); p.onPlayRevision(); assert(p.reach() == nil) end
-- The file is gone: the owner is told.
game.files[Play.PLAY] = nil; file({}, {reach = {enabled = true, items = {good}}}); p.onPlayRevision(); assert(p.reach() ~= nil)
game.files[Play.PLAY] = nil; p.onPlayRevision(); assert(p.reach() == nil and handed[#handed] == false)
-- The world ended: gone, and read again by restore.
file({}, {reach = {enabled = true, items = {good}}}); p.restore(); assert(p.reach() ~= nil)
p.abandon(); assert(p.reach() == nil and handed[#handed] == false)
p.restore(); assert(p.reach() ~= nil)
-- A raising owner does not stop the file from being applied.
local q = Play.new({enabled = function() return true end, clock = clock, gameTime = function() return game.gameClock end, read = function(path) return game.files[path] end,
  write = function() return true end, encode = serialize, decode = decode, places = places, lines = lines, prims = prims, session = 's3', log = log, onReach = function() error('owner broke') end})
q.restore(); assert(q.reach() ~= nil and logged('the reach block could not be handed over'))
`));

test('reach: P.refresh reads the play file now (and only with the setting on), the same file costs the read and a compare', () => withGame(`
file({}, {reach = {enabled = true, items = {{id = 'a-one', character = 'panam-palmer', via = 'text', text = 'x'}}}})
assert(play.reach() == nil, 'nothing read yet')
assert(play.refresh() == true and play.reach() ~= nil)
local decodes = game.decodes
play.refresh(); assert(game.decodes == decodes, 'an unchanged file is not decoded again')
file({}, {reach = {enabled = true, items = {{id = 'b-two', character = 'panam-palmer', via = 'text', text = 'y'}}}})
play.refresh(); assert(play.reach().items[1].id == 'b-two')
game.enabled = false; file({}, {}); assert(play.refresh() == false and play.reach().items[1].id == 'b-two', 'the setting is off: not read')
`));

test('reach: P.emitReach writes the event reach:<id> with pack reach and serial 0 at once, with optional data, and nothing for a bad id', () => withGame(`
assert(play.emitReach('pr-bond5') == true)
local value = events()
assert(#value.events == 1)
local e = value.events[1]
assert(e.pack == 'reach' and e.serial == 0 and e.name == 'reach:pr-bond5' and e.seq == 1 and e.at == 100000, e.name)
assert(play.emitReach('with-data', {minutes = 3, junk = {1}}) == true)
local second = events().events[2]
assert(second.name == 'reach:with-data' and second.data.minutes == 3 and second.data.junk == nil)
for _, bad in ipairs({'', 'Bad Id', 'x', 7, 'a:b', string.rep('a', 40)}) do assert(play.emitReach(bad) == false) end
assert(#events().events == 2)
-- No quest, no script row, no armed timer: the write failing is tried again by the steps, and given up after twenty failures.
game.writeFails = true; assert(play.emitReach('late-one') == true and play.armed())
game.writeFails = false; step(2); assert(count('reach:late-one') == 1 and not play.armed())
`));

test('the events file carries the game clock as a top-level at', () => withGame(`
file({quest({script = {{when = 'stage:enter', event = 'x:y'}}})}); play.restore()
local value = events()
assert(value.at == 100000, 'at: ' .. tostring(value.at))
game.gameClock = 100500; play.inject('probe:z')
assert(events().at == 100500)
`));

test('a stage whose opening lines have nobody to say them (she is only a voice on the phone) waits for her: no subtitle, no gap, and the lines are dropped with the stage', () => withGame(`
game.absent = true; game.startFail = 'no-speaker'
local lineTable = {['P3.dare.01'] = say, ['P3.dare.02'] = say}
local q = quest({gaps = {g1 = {}}, lines = lineTable, script = {{when = 'stage:enter', say = 'P3.dare.01'}, {when = 'stage:enter', say = 'P3.dare.02'}, {when = 'line:P3.dare.02:done', gap = 'g1'}}})
file({q}); play.restore()
step(60)
assert(#game.started == 0 and #game.subtitles == 0 and #game.phones == 0 and not lines.gapOpen(), 'nobody speaks, nothing is shown, the gap stays shut')
-- The bridge moves the quest to another stage (V answered over the phone): the lines of the old stage are gone.
local q2 = quest({stage = 'run', serial = 2, lines = {['P3.run.01'] = say}, script = {{when = 'stage:enter', say = 'P3.run.01'}}})
file({q2}, {revision = 2}); play.onPlayRevision(); step(2)
game.absent = false; game.startFail = nil; step(3)
assert(#game.started == 1 and game.started[1].id == 'P3.run.01', 'only the new stage line plays: ' .. #game.started)
`));

test('the same stage, her copy arrives: the lines play in order and the gap opens after the last of them', () => withGame(`
game.absent = true; game.startFail = 'no-speaker'
local q = quest({gaps = {g1 = {}}, lines = {['P3.dare.01'] = say, ['P3.dare.02'] = say}, script = {{when = 'stage:enter', say = 'P3.dare.01'}, {when = 'stage:enter', say = 'P3.dare.02'}, {when = 'line:P3.dare.02:done', gap = 'g1'}}})
file({q}); play.restore(); step(30)
assert(#game.started == 0)
game.absent = false; game.startFail = nil; step(2)
assert(#game.started == 1 and game.started[1].id == 'P3.dare.01')
lines.stopped('r1', 'finished'); step(2)
assert(#game.started == 2 and game.started[2].id == 'P3.dare.02')
lines.stopped('r2', 'finished'); step(1)
assert(lines.gapOpen() and names():find('gap:g1:open', 1, true), names())
`));

test('a line of an ending whose speaker is not here goes to her thread after 20 s and counts as done', () => withGame(`
game.absent = true; game.startFail = 'no-speaker'
file({}); play.restore()
file({}, {closing = {{pack = 'panam-sunset-coffee', character = 'panam-palmer', ending = 'chicken', serial = 6, lines = {['P3.c'] = say},
  script = {{when = 'ending:chicken', say = 'P3.c'}}}}, revision = 2})
play.onPlayRevision(); step(5)
assert(#game.phones == 0 and #game.subtitles == 0)
step(20)
assert(#game.phones == 1 and game.phones[1].text == 'Words.' and #game.subtitles == 0 and #game.started == 0)
local e = events().events; assert(e[#e].name == 'line:P3.c:done' and e[#e].serial == 6, e[#e].name)
`));

test('no time limit: a stage has no timer, even when an older bridge writes a timeoutAt, and V can abandon a quest (the event goes to the bridge)', () => withGame(`
-- A quest stage never times out in the game: not with no timeoutAt, not with one an older bridge still wrote, however long the game runs.
file({quest({stage = 'call', timeoutAt = game.gameClock + 60})}); play.restore()
step(30)
assert(count('stage:enter') == 1, 'the stage started once')
assert(not names():find('stage:timeout', 1, true), 'no timer: ' .. names())
assert(not logged('timeout clock runs'), 'and the game never says a clock runs')
step(300); assert(not names():find('stage:timeout', 1, true), 'no timer however long it runs')
-- V abandons it: the event reaches the bridge with the stage's serial, and a pack that is not armed says no.
assert(play.abandonQuest('panam-sunset-coffee') == true)
step(1.1)
assert(count('quest:abandon') == 1, names())
assert(play.abandonQuest('no-such-pack') == false)
`));
