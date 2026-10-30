// The music and sound effects of the bond quests, the game half (mod/quest-audio.lua and mod/quest-world-audio.lua, docs/QUEST_PRIMITIVES.md section 10.10): the sources (a pack
// file through the bridge's command file, a car radio station, a game sound event), the start and stop events, the fades, the shape of runtime/media-command.json, the positions
// (a copy's pan once, a place loop steered at most four times a second within 60 m) and the reap. Run on a fake game: a clock, files in memory, a car with a radio, an audio system.
// The real quest module and primitives run behind it. Nothing here starts the game.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import {run, load, source, read, base} from './quest-lua-fixture.mjs';
import {parseMediaCommandFile, parseMediaReaction} from './media-request.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
// Runs Lua that returns a string (the JSON of what the module wrote) and gives it back.
function value(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  try {
    const status = lauxlib.luaL_dostring(state, to_luastring(code));
    const text = to_jsstring(lua.lua_tostring(state, -1));
    assert.equal(status, lua.LUA_OK, text);
    return text;
  } finally { lua.lua_close(state); }
}

const harness = `
local Places = ${load('quest-places.lua')}
local Prims = ${load('quest-prims.lua')}
local Lines = ${load('quest-lines.lua')}
local Audio = ${load('quest-audio.lua')}
local Play = ${load('quest-play.lua')}
${base}
local game = {now = 0, gameClock = 100000, tick = 0, files = {}, writes = {}, writeFails = false, calls = {}, vpos = {x = 0, y = 0, z = 0}, cam = {x = 0, y = 0, z = 0, fx = 0, fy = 1},
  copy = {x = 10, y = 0, z = 0}, plays = {}, stops = {}, gameFails = false, car = nil, radioLog = {}, stations = {'Pacific Dreams', 'Radio Pebkac', 'Impulse 99.9'}}
local function counted(name, fn) return function(...) game.calls[name] = (game.calls[name] or 0) + 1; return fn(...) end end
local world = {
  playerPosition = counted('playerPosition', function() return {x = game.vpos.x, y = game.vpos.y, z = game.vpos.z} end),
  copyOf = counted('copyOf', function(key) if not game.copy then return nil end return {kind = 'party', serial = 1, position = {x = game.copy.x, y = game.copy.y, z = game.copy.z}} end),
  cameraPose = counted('cameraPose', function() if not game.cam then return nil end return {x = game.cam.x, y = game.cam.y, z = game.cam.z, fx = game.cam.fx, fy = game.cam.fy} end),
  gamePlay = counted('gamePlay', function(event, key)
    if game.gameFails then return nil, 'no audio system' end
    game.plays[#game.plays + 1] = event .. (key and ('@' .. key) or '')
    return {event = event, id = key and 'id-' .. key or nil}
  end),
  gameStop = counted('gameStop', function(handle) game.stops[#game.stops + 1] = handle.event .. (handle.id and ('@' .. handle.id) or ''); return true end),
  radioSwitch = counted('radioSwitch', function(station, keep)
    if not game.car then return nil, 'V is on foot' end
    local found
    for index, name in ipairs(game.stations) do if name:lower() == station:lower() then found = index - 1 end end
    if not found then return nil, 'no station named ' .. station end
    local token = keep or {wasOn = game.car.on, index = game.car.index}
    game.car.on, game.car.index = true, found
    game.radioLog[#game.radioLog + 1] = 'to:' .. station
    return token
  end),
  radioRestore = counted('radioRestore', function(token)
    if not game.car then return false, 'V left the vehicle' end
    game.car.on, game.car.index = token.wasOn, token.index
    game.radioLog[#game.radioLog + 1] = 'restore'
    return true
  end),
}
local clock = function() return game.now end
local places = Places.new({world = world, clock = clock, log = log})
local prims = Prims.new({places = places, world = world, clock = clock, gameTime = function() return game.gameClock end, log = log})
prims.env.audioNatives = {}
prims.env.audioSession = 'sess9'
prims.env.audioEncode = serialize
prims.env.audioWrite = function(path, text)
  if game.writeFails then return false end
  assert(path == 'runtime/media-command.json', path)
  game.writes[#game.writes + 1] = decode(text); game.files[path] = text; return true
end
assert(prims.extend(Audio))
local lines = Lines.new({clock = clock, gameTime = function() return game.gameClock end, log = log, busy = function() return false end,
  start = function() return 'r1' end, phone = function() return true end, emit = function() end})
local play = Play.new({
  enabled = function() return true end, clock = clock, gameTime = function() return game.gameClock end,
  read = function(path) return game.files[path] end, write = function(path, text) game.files[path] = text; return true end,
  encode = serialize, decode = decode, places = places, lines = lines, prims = prims, session = 'sess1', log = log})
local sounds = prims.sounds
local function tick(seconds)
  for _ = 1, math.floor(seconds * 10 + 0.5) do
    game.now = game.now + 0.1; game.gameClock = game.gameClock + 0.1; game.tick = game.tick + 1
    play.update('V', 0.1)
    if sounds.pending() then sounds.update(0.1) end
  end
end
local function file(quests, extra)
  local value = {version = 1, revision = 1, quests = quests}
  for k, v in pairs(extra or {}) do value[k] = v end
  game.files[Play.PLAY] = serialize(value)
end
local function quest(fields)
  local q = {pack = 'panam-sunset-coffee', character = 'panam-palmer', stage = 'walk', serial = 3, since = 99990,
    places = {rig = {x = 100, y = 0, z = 0, radius = 5}}, ['do'] = {}, script = {}, lines = {}, gaps = {}}
  for k, v in pairs(fields or {}) do q[k] = v end
  return q
end
local function settle() if sounds.pending() then tick(0.3) end end
local function commands() settle(); local list = {} for _, w in ipairs(game.writes) do for _, c in ipairs(w.commands) do list[#list + 1] = c end end return list end
local function ops() settle(); local list = {} for _, c in ipairs(commands()) do list[#list + 1] = c.op .. (c.id and (':' .. c.id) or '') end return table.concat(list, ' ') end
local function last() settle(); local w = game.writes[#game.writes]; return w and w.commands[#w.commands] end
local function calls(name) return game.calls[name] or 0 end
`;
const withGame = code => run(`${harness}\n${code}`);

test('install: the hook and the sounds object exist, and a stage with no music or effects costs nothing and writes nothing', () => withGame(`
assert(type(prims.stageStart) == 'function' and prims.sounds ~= nil and sounds.pending() == false)
file({quest()}); play.restore(); tick(30)
assert(#game.writes == 0 and game.files['runtime/media-command.json'] == nil, 'never written when there is nothing to say')
assert(calls('playerPosition') == 0 and calls('cameraPose') == 0)
`));

test('a file of the pack plays at the stage start: one play command with only the fields the item has, in the file the bridge reads', () => withGame(`
file({quest({music = {{source = 'file:music/sunset.ogg', fadeIn = 2, fadeOut = 3, volume = 0.6, duck = true}}})}); play.restore()
assert(#game.writes == 0 and sounds.pending(), 'queued: it goes out with the next 0.1 s tick')
tick(0.2)
assert(#game.writes == 1)
local w = game.writes[1]
assert(w.version == 1 and w.session == 'sess9' and w.seq == 1 and #w.commands == 1)
local c = w.commands[1]
assert(c.kind == 'media' and c.op == 'play' and c.pack == 'panam-sunset-coffee' and c.id == 'm3-1' and c.file == 'music/sunset.ogg')
assert(c.fadeIn == 2 and c.fadeOut == 3 and c.volume == 0.6 and c.duck == true and c.loop == nil and c.at == nil and c.pan == nil)
`));

test('an effect: loop, volume, at and no duck field; and a bed or v effect carries no pan', () => withGame(`
file({quest({sfx = {{source = 'file:sfx/rain.ogg', loop = true, volume = 0.3, at = 'bed'}, {source = 'file:sfx/door.wav', at = 'v'}}})}); play.restore()
tick(1)
local list = commands()
assert(#list == 2, #list)
local a, b = list[1], list[2]
assert(a.id == 's3-1' and a.file == 'sfx/rain.ogg' and a.loop == true and a.volume == 0.3 and a.at == nil and a.duck == nil and a.pan == nil)
assert(b.id == 's3-2' and b.file == 'sfx/door.wav' and b.at == 'v' and b.loop == nil and b.pan == nil)
assert(#game.writes == 1 and game.writes[1].seq == 1, 'two commands of one moment go out together')
`));

test('every command the module writes is one the bridge accepts, and the whole file parses', () => {
  // the shapes, as the bridge parses them (bridge/media-request.mjs)
  const lines = [
    {kind: 'media', op: 'play', pack: 'panam-sunset-coffee', id: 'm3-1', file: 'music/sunset.ogg', fadeIn: 2, fadeOut: 3, volume: 0.6, duck: true},
    {kind: 'media', op: 'play', pack: 'panam-sunset-coffee', id: 's3-1', file: 'sfx/rain.ogg', loop: true, volume: 0.3, at: 'place:rig', pan: -0.5},
    {kind: 'media', op: 'load', pack: 'panam-sunset-coffee', file: 'sfx/door.wav'},
    {kind: 'media', op: 'stop', pack: 'panam-sunset-coffee', id: 'm3-1', fadeOut: 3},
    {kind: 'media', op: 'stop', pack: 'panam-sunset-coffee'},
    {kind: 'media', op: 'fade', pack: 'panam-sunset-coffee', id: 's3-1', volume: 0.2, pan: 0.4, seconds: 0.3},
  ];
  for (const line of lines) assert.ok(parseMediaReaction(line), JSON.stringify(line));
  const file = parseMediaCommandFile(JSON.stringify({version: 1, session: 'sess9', seq: 1, commands: lines}));
  assert.equal(file.commands.length, 6);
  assert.equal(file.rejected, 0);
});


// A JSON encoder for the Lua tables the fake write receives (sorted keys, arrays by length).
const jsonOf = `
local function json(v)
  if type(v) == 'table' then
    if #v > 0 then local p = {} for _, x in ipairs(v) do p[#p + 1] = json(x) end return '[' .. table.concat(p, ',') .. ']' end
    local keys = {} for k in pairs(v) do keys[#keys + 1] = k end table.sort(keys)
    local p = {} for _, k in ipairs(keys) do p[#p + 1] = string.format('%q', k) .. ':' .. json(v[k]) end return '{' .. table.concat(p, ',') .. '}'
  elseif type(v) == 'string' then return string.format('%q', v) elseif type(v) == 'boolean' or type(v) == 'number' then return tostring(v) end
  return 'null'
end
local function writesJson() local text = {} for _, w in ipairs(game.writes) do text[#text + 1] = json(w) end return table.concat(text, '\\n') end
`;
const writesOf = code => value(`${harness}\n${jsonOf}\n${code}\nreturn writesJson()`).split('\n').filter(Boolean).map(line => JSON.parse(line));

test('the real commands of a busy stage all parse with the bridge parser, with the session fixed and the seq counting up', () => {
  const writes = writesOf(`
file({quest({music = {{source = 'file:music/a.ogg', start = 'go', stop = 'end', fadeIn = 1, fadeOut = 1, volume = 1}},
  sfx = {{source = 'file:sfx/b.ogg', at = 'place:rig', loop = true, volume = 0.5}, {source = 'file:sfx/c.ogg', at = 'copy', volume = 0.8}}})}); play.restore()
tick(1); play.inject('go'); tick(1); play.inject('end'); tick(1); file({}); play.onPlayRevision(); tick(1)`);
  assert.ok(writes.length >= 4, `${writes.length} writes`);
  let seq = 0;
  const seen = [];
  for (const write of writes) {
    const parsed = parseMediaCommandFile(JSON.stringify(write));
    assert.ok(parsed, JSON.stringify(write));
    assert.equal(parsed.rejected, 0, JSON.stringify(write));
    assert.equal(parsed.session, 'sess9');
    assert.ok(parsed.seq > seq, 'seq grows'); seq = parsed.seq;
    assert.ok(write.commands.length >= 1 && write.commands.length <= 8);
    for (const command of parsed.commands) seen.push(`${command.op}:${command.id ?? command.file ?? '*'}`);
  }
  // loads at arm for the music that starts later; plays; the music stops on its event; the rest at the reap; the pack stop at the quest's end
  for (const wanted of ['load:music/a.ogg', 'play:s3-1', 'play:s3-2', 'play:m3-1', 'stop:m3-1', 'stop:s3-1', 'stop:*']) assert.ok(seen.includes(wanted), `${wanted} in ${seen.join(' ')}`);
});

test('the sources in one stage: a file, a station, and a game event, each handed to its player, and what was started is in the log', () => withGame(`
game.car = {on = false, index = 2}
file({quest({music = {{source = 'radio:Radio Pebkac'}, {source = 'file:music/a.ogg'}}, sfx = {{source = 'game:ui_jingle_quest_new'}}})}); play.restore()
assert(game.car.on == true and game.car.index == 1 and game.radioLog[1] == 'to:Radio Pebkac')
assert(ops() == 'play:m3-2' and #game.writes == 1, ops())
assert(game.plays[1] == 'ui_jingle_quest_new')
assert(logged('started panam-sunset-coffee m3-1 radio:Radio Pebkac') and logged('started panam-sunset-coffee m3-2 file:music/a.ogg') and logged('started panam-sunset-coffee s3-1 game:ui_jingle_quest_new'))
`));

test('start and stop are events of the stage: start defaults to stage:enter, a later start is loaded at arm (no sound) and played at its event, stop fades out', () => withGame(`
file({quest({music = {{source = 'file:music/a.ogg', start = 'place:rig:arrived', stop = 'together:t:done', fadeIn = 2, fadeOut = 4}}})}); play.restore()
assert(ops() == 'load', ops())
assert(last().op == 'load' and last().file == 'music/a.ogg' and last().id == nil)
tick(1); play.inject('place:rig:arrived'); tick(0.5)
assert(last().op == 'play' and last().id == 'm3-1' and last().fadeIn == 2)
local before = #game.writes
play.inject('place:rig:arrived'); tick(1); assert(#game.writes == before, 'playing already: nothing again')
tick(1); play.inject('together:t:done'); tick(0.5)
assert(last().op == 'stop' and last().id == 'm3-1' and last().fadeOut == 4 and last().pack == 'panam-sunset-coffee')
tick(1); play.inject('together:t:done'); tick(1)
assert(ops() == 'load play:m3-1 stop:m3-1', ops())
-- started again by its event, once more
play.inject('place:rig:arrived'); tick(1); assert(last().op == 'play')
`));

test('the command file: a write is never closer than 0.25 s to the last, what waits goes out in the next write, at most 8 commands, seq +1 per write', () => withGame(`
local list = {}
for i = 1, 6 do list[#list + 1] = {source = 'file:sfx/e' .. i .. '.ogg', start = 'go'} end
file({quest({sfx = list, music = {{source = 'file:music/a.ogg', start = 'go'}, {source = 'file:music/b.ogg', start = 'go'}, {source = 'file:music/c.ogg', start = 'go'}}})}); play.restore()
local loads = 0
for _, c in ipairs(commands()) do if c.op == 'load' then loads = loads + 1 end end
assert(loads == 4, 'loads are capped at 4 a stage: ' .. loads)
tick(1)
play.inject('go')
tick(2)
for _, w in ipairs(game.writes) do assert(#w.commands <= 8 and #w.commands >= 1) end
for i = 2, #game.writes do assert(game.writes[i].seq == game.writes[i - 1].seq + 1) end
local plays = 0
for _, c in ipairs(commands()) do if c.op == 'play' then plays = plays + 1 end end
assert(plays == 9, plays)
assert(not sounds.pending(), 'everything went out')
`));

test('two events closer than 0.25 s do not overwrite each other: the second command waits and is written later', () => withGame(`
file({quest({music = {{source = 'file:music/a.ogg', start = 'a'}}, sfx = {{source = 'file:sfx/b.ogg', start = 'b'}}})}); play.restore(); tick(2)
local n = #game.writes
play.inject('a'); tick(0.1)
assert(#game.writes == n + 1)
play.inject('b'); tick(0.1)
assert(#game.writes == n + 1 and sounds.pending(), 'the second is queued, 0.1 s after the last write')
tick(0.3)
assert(#game.writes == n + 2 and not sounds.pending())
assert(game.writes[n + 1].seq + 1 == game.writes[n + 2].seq)
assert(game.writes[n + 1].commands[1].id == 'm3-1' and game.writes[n + 2].commands[1].id == 's3-1')
`));

test('a write that fails is tried again until it works', () => withGame(`
game.writeFails = true
file({quest({music = {{source = 'file:music/a.ogg'}}})}); play.restore()
tick(1); assert(sounds.pending() and #game.writes == 0)
game.writeFails = false; tick(1)
assert(#game.writes == 1 and game.writes[1].seq == 1 and not sounds.pending())
`));

test('a write that never works is given up after twenty tries without raising', () => withGame(`
game.writeFails = true
file({quest({music = {{source = 'file:music/a.ogg'}}})}); play.restore()
tick(10); assert(not sounds.pending() and #game.writes == 0 and logged('cannot be written'))
`));

test('at copy: the pan is computed once, from the camera and the copy, with the sign of the speech pan (right is positive)', () => withGame(`
game.cam = {x = 0, y = 0, z = 0, fx = 0, fy = 1}
game.copy = {x = 10, y = 0, z = 0}
file({quest({sfx = {{source = 'file:sfx/step.ogg', at = 'copy'}}})}); play.restore()
local c = last()
assert(c.at == 'copy' and math.abs(c.pan - 1) < 1e-6, tostring(c.pan))
assert(calls('cameraPose') == 1 and calls('copyOf') == 1)
tick(30); assert(calls('cameraPose') == 1 and calls('copyOf') == 1, 'read once')
file({quest({serial = 4, sfx = {{source = 'file:sfx/step.ogg', at = 'copy'}}})}); game.copy = {x = -10, y = 0, z = 0}; play.onPlayRevision()
assert(math.abs(last().pan + 1) < 1e-6)
file({quest({serial = 5, sfx = {{source = 'file:sfx/step.ogg', at = 'copy'}}})}); game.copy = {x = 0, y = 10, z = 0}; play.onPlayRevision()
assert(math.abs(last().pan) < 1e-6)
file({quest({serial = 6, sfx = {{source = 'file:sfx/step.ogg', at = 'copy'}}})}); game.copy = nil; play.onPlayRevision()
assert(last().op == 'play' and last().id == 's6-1' and last().pan == nil and last().at == 'copy')
file({quest({serial = 7, sfx = {{source = 'file:sfx/step.ogg', at = 'copy'}}})}); game.copy = {x = 3, y = 3, z = 0}; game.cam = nil; play.onPlayRevision()
assert(last().id == 's7-1' and last().pan == nil)
`));

test('a place loop is steered with fade commands, at most four a second, only within 60 m, silent beyond, and the steering stops with the loop', () => withGame(`
game.vpos = {x = 30, y = 0, z = 0}      -- 70 m from the rig at x = 100: out of range
file({quest({sfx = {{source = 'file:sfx/hum.ogg', at = 'place:rig', loop = true, volume = 0.8, stop = 'rig:off'}}})}); play.restore()
local c = commands()[1]
assert(c.op == 'play' and c.at == 'place:rig' and c.loop == true and c.volume == 0 and c.pan == 0, 'starts silent beyond 60 m')
local reads, cams = calls('playerPosition'), calls('cameraPose')
tick(10)
local far = calls('playerPosition') - reads
assert(far >= 4 and far <= 6, 'every 2 s: ' .. far)
assert(calls('cameraPose') == cams and #game.writes == 1)
game.vpos = {x = 60, y = 0, z = 0}
local before = #game.writes
tick(2.1)
local fade = last()
assert(fade.op == 'fade' and fade.id == 's3-1' and fade.volume > 0 and fade.volume < 0.8 and math.abs(fade.pan - 1) < 1e-6 and fade.seconds == 0.3, fade.op)
game.vpos = {x = 90, y = 0, z = 0}; tick(0.6)
local near = last()
assert(near.volume > fade.volume and near.volume <= 0.8)
local n = #game.writes
tick(3); assert(#game.writes == n, 'nothing changed, nothing sent')
local rate0, t0 = calls('playerPosition'), game.now
for i = 1, 30 do game.vpos = {x = 60 + i, y = 0, z = 0}; tick(0.1) end
local perSecond = (calls('playerPosition') - rate0) / (game.now - t0)
assert(perSecond <= 4.2, perSecond)
local writesPerSecond = (#game.writes - n) / (game.now - t0)
assert(writesPerSecond <= 4.2, writesPerSecond)
game.vpos = {x = 20, y = 0, z = 0}; tick(2.5)
assert(last().op == 'fade' and last().volume == 0)
local silent = #game.writes
tick(10); assert(#game.writes == silent)
play.inject('rig:off'); tick(0.5)
assert(last().op == 'stop' and last().id == 's3-1')
local after = calls('playerPosition')
tick(20); assert(calls('playerPosition') == after and not sounds.pending(), 'no recurring read once the loop is off')
`));

test('a one-shot at a place is mixed once at the start, not steered; a place the stage does not carry is not played', () => withGame(`
game.vpos = {x = 95, y = 0, z = 0}
file({quest({sfx = {{source = 'file:sfx/knock.ogg', at = 'place:rig', volume = 1}, {source = 'file:sfx/ghost.ogg', at = 'place:nowhere', loop = true}}})}); play.restore()
local list = commands()
assert(#list == 1 and list[1].file == 'sfx/knock.ogg' and list[1].at == 'place:rig' and list[1].volume > 0.9 and list[1].loop == nil, #list)
assert(logged('which the stage does not carry'))
tick(30); assert(calls('playerPosition') == 1 and #game.writes == 1, 'a one-shot is never steered')
`));

test('radio: the car radio is switched to the station by name and given back as it was (station and on or off) on the stop event, and on the reap', () => withGame(`
game.car = {on = true, index = 2}
file({quest({music = {{source = 'radio:Radio Pebkac', start = 'go', stop = 'end'}}})}); play.restore()
assert(game.car.index == 2 and #game.radioLog == 0, 'nothing before the start event')
play.inject('go'); assert(game.car.on and game.car.index == 1)
play.inject('end'); assert(game.car.on and game.car.index == 2 and game.radioLog[2] == 'restore')
game.car.on, game.car.index = false, 0; game.radioLog = {}
play.inject('go'); assert(game.car.on and game.car.index == 1)
file({}); play.onPlayRevision()
assert(game.car.on == false and game.car.index == 0 and game.radioLog[2] == 'restore', 'the reap gives it back')
assert(#game.writes == 0, 'a radio is not the bridge business')
`));

test('radio: on foot, or a station that does not exist, does nothing, says so once, and a stop gives back nothing', () => withGame(`
game.car = nil
file({quest({music = {{source = 'radio:Radio Pebkac', start = 'go', stop = 'end'}}})}); play.restore()
play.inject('go'); play.inject('end'); play.inject('go')
assert(calls('radioSwitch') == 2 and calls('radioRestore') == 0 and logged('was not switched to (V is on foot)'))
local n = 0 for _, l in ipairs(logs) do if l:find('was not switched to', 1, true) then n = n + 1 end end
assert(n == 1, 'said once')
game.car = {on = true, index = 2}
file({quest({serial = 4, music = {{source = 'radio:No Such Station'}}})}); play.onPlayRevision()
assert(game.car.index == 2 and calls('radioRestore') == 0 and logged('no station named'))
`));

test('radio: two items share one restore, the radio goes back to the state before the first switch only when the last one stops', () => withGame(`
game.car = {on = true, index = 2}
file({quest({music = {{source = 'radio:Radio Pebkac', start = 'a', stop = 'a-off'}, {source = 'radio:Impulse 99.9', start = 'b', stop = 'b-off'}}})}); play.restore()
play.inject('a'); play.inject('b'); assert(game.car.index == 2, tostring(game.car.index))
play.inject('a-off'); assert(calls('radioRestore') == 0, 'still held by the second')
play.inject('b-off'); assert(calls('radioRestore') == 1 and game.car.index == 2 and game.car.on == true)
`));

test('game sounds: flat by default, on the copy for at copy, stopped by the stop event, a loop and a music event are stopped by the reap, a one-shot is left to finish', () => withGame(`
file({quest({
  sfx = {{source = 'game:amb_rain_loop', loop = true}, {source = 'game:ono_v_laugh', at = 'copy'}, {source = 'game:ui_jingle', stop = 'jingle:off'}},
  music = {{source = 'game:mus_cue_start'}}})}); play.restore()
assert(table.concat(game.plays, ',') == 'mus_cue_start,amb_rain_loop,ono_v_laugh@panam-palmer,ui_jingle', table.concat(game.plays, ','))
assert(#game.writes == 0, 'game sounds never reach the bridge')
play.inject('jingle:off'); assert(game.stops[1] == 'ui_jingle')
file({}); play.onPlayRevision()
table.sort(game.stops)
assert(table.concat(game.stops, ',') == 'amb_rain_loop,mus_cue_start,ui_jingle', table.concat(game.stops, ','))
assert(#game.writes == 0)
`));

test('a game sound that cannot start is logged once and nothing else happens', () => withGame(`
game.gameFails = true
file({quest({sfx = {{source = 'game:not_a_real_event'}}})}); play.restore()
assert(logged('the game sound not_a_real_event did not start') and #game.stops == 0)
file({quest({serial = 4, sfx = {{source = 'game:not_a_real_event'}}})}); play.onPlayRevision()
local n = 0 for _, l in ipairs(logs) do if l:find('did not start', 1, true) then n = n + 1 end end
assert(n == 1, n)
`));

test('the reap stops every id the stage started (with its own fade), a quest that ends stops the whole pack, and a stage with nothing started writes nothing', () => withGame(`
file({quest({music = {{source = 'file:music/a.ogg', fadeOut = 3}}, sfx = {{source = 'file:sfx/b.ogg', loop = true, fadeOut = 1}, {source = 'file:sfx/c.ogg', start = 'never'}}})}); play.restore(); tick(1)
local n = #game.writes
file({quest({serial = 4, stage = 'sit'})}); play.onPlayRevision(); tick(1)
local stops = {}
for i = n + 1, #game.writes do for _, c in ipairs(game.writes[i].commands) do stops[#stops + 1] = c.op .. ':' .. tostring(c.id) .. ':' .. tostring(c.fadeOut) end end
table.sort(stops)
assert(table.concat(stops, ' ') == 'stop:m3-1:3 stop:s3-1:1', table.concat(stops, ' '))
local m = #game.writes
tick(30); assert(#game.writes == m)
file({}); play.onPlayRevision(); tick(1)
local final = last()
assert(final.op == 'stop' and final.id == nil and final.pack == 'panam-sunset-coffee', final.op)
local k = #game.writes
file({quest({serial = 9})}); play.onPlayRevision(); file({}); play.onPlayRevision(); tick(1)
assert(#game.writes == k, 'nothing started since: nothing to say')
`));

test('the quest ends while its sounds play: each id is stopped with its fade and the pack stop follows with the longest fade', () => withGame(`
file({quest({music = {{source = 'file:music/a.ogg', fadeOut = 3}}, sfx = {{source = 'file:sfx/b.ogg', fadeOut = 5}}})}); play.restore(); tick(1)
file({}); play.onPlayRevision(); tick(1)
local list = {}
for _, c in ipairs(commands()) do if c.op == 'stop' then list[#list + 1] = tostring(c.id) .. ':' .. tostring(c.fadeOut) end end
table.sort(list)
assert(table.concat(list, ' ') == 'm3-1:3 nil:5 s3-1:5', table.concat(list, ' '))
`));

test('a sound started and stopped before its play went out is never sent', () => withGame(`
file({quest({music = {{source = 'file:music/a.ogg', start = 'go', stop = 'end'}}, sfx = {{source = 'file:sfx/x.ogg', start = 'go2'}}})}); play.restore(); tick(2)
play.inject('go2')
play.inject('go')
play.inject('end')
tick(1)
assert(ops():find('play:m3-1', 1, true) == nil and ops():find('stop:m3-1', 1, true) == nil, ops())
assert(ops():find('play:s3-1', 1, true))
`));

test('a world change (a load) stops what the bridge plays for each pack, asks the game loops to stop, forgets the radio and every steered loop', () => withGame(`
game.car = {on = true, index = 2}
file({quest({music = {{source = 'file:music/a.ogg'}, {source = 'radio:Radio Pebkac'}}, sfx = {{source = 'file:sfx/hum.ogg', at = 'place:rig', loop = true}, {source = 'game:amb_loop', loop = true}}})}); play.restore(); tick(1)
local n = #game.writes
play.abandon(); sounds.worldChanged(); tick(1)
local final = last()
assert(#game.writes == n + 1 and final.op == 'stop' and final.id == nil and final.pack == 'panam-sunset-coffee')
assert(game.stops[1] == 'amb_loop' and calls('radioRestore') == 0, 'the radio is not asked in a world that is gone')
local reads = calls('playerPosition')
tick(10); assert(calls('playerPosition') == reads and not sounds.pending())
`));

test('nothing per frame: idle, the tick function is a boolean; a playing bed with no place costs no native call at all', () => withGame(`
file({quest({sfx = {{source = 'file:sfx/rain.ogg', loop = true}}})}); play.restore(); tick(1)
assert(sounds.pending() == false)
local before = 0 for _, v in pairs(game.calls) do before = before + v end
tick(120)
local after = 0 for _, v in pairs(game.calls) do after = after + v end
assert(after == before, 'no native call in two minutes of a bed')
`));

test('items the game cannot play are skipped with a log and the others still play: a bad source, a radio in sfx, a folder that does not match the kind', () => withGame(`
file({quest({music = {{source = 'file:sfx/x.ogg'}, {source = 'nonsense'}, {source = 'file:music/ok.ogg'}}, sfx = {{source = 'radio:Impulse 99.9'}, {source = 'file:music/x.ogg'}}})}); play.restore()
assert(ops() == 'play:m3-3', ops())
`));

test('the wiring: init.lua loads the call and sound modules as extras, hands the line player to the primitives, ticks the sounds only while pending, and stops them on a world change', () => {
  const init = read('../mod/init.lua');
  assert.match(init, /'quest-prims-systems\.lua',\s*'quest-prims-calls\.lua', 'quest-audio\.lua'\}/);
  assert.match(init, /prims\.env\.lines = lines/);
  assert.match(init, /local sounds = convaiQuestPrims and convaiQuestPrims\.sounds\s*if sounds ~= nil and sounds\.pending\(\) then/);
  assert.match(init, /pcall\(sounds\.worldChanged\)/);
  assert.match(init, /convaiQuestCallLines ~= true then return true end/);
  const play = read('../mod/quest-play.lua');
  assert.match(play, /calls = type\(q\.calls\) == 'table' and q\.calls or nil, music = type\(q\.music\) == 'table' and q\.music or nil, sfx = type\(q\.sfx\) == 'table' and q\.sfx or nil/);
  assert.match(play, /pcall\(prims\.stageStart, c\.ctx, c\)/);
});

test('the pan and the gain helpers', () => withGame(`
local pose = {x = 0, y = 0, fx = 1, fy = 0}
assert(math.abs(Audio.pan(pose, {x = 0, y = -10}) - 1) < 1e-6, 'south is on the right when looking east')
assert(math.abs(Audio.pan(pose, {x = 0, y = 10}) + 1) < 1e-6)
assert(Audio.pan(pose, {x = 10, y = 0}) == 0 and Audio.pan(pose, {x = 0, y = 0}) == 0)
assert(Audio.pan(nil, {x = 1, y = 1}) == nil and Audio.pan(pose, {}) == nil)
assert(Audio.gain(0) == 1 and Audio.gain(5) == 1 and Audio.gain(60) == 0 and Audio.gain(100) == 0)
assert(Audio.gain(30) > Audio.gain(50) and Audio.gain(30) < 1)
`));

test('the world natives: the camera pan source, the station by name, the radio switch and restore, the game sound calls (a fake audio system, vehicle and camera)', () => run(`
local W = ${load('quest-world-audio.lua')}
${base}
local audio = {plays = {}, stops = {}}
function audio:Play(name, id) audio.plays[#audio.plays + 1] = tostring(name) .. (id and ('@' .. tostring(id)) or '') end
function audio:Stop(name, id) audio.stops[#audio.stops + 1] = tostring(name) .. (id and ('@' .. tostring(id)) or '') end
local stations = {[0] = 'Pacific Dreams', 'Radio Pebkac', 'Impulse 99.9', 'Morro Rock Radio'}
local car = {on = false, index = 1, hash = '77', log = {}}
function car:IsRadioReceiverActive() return self.on end
function car:GetCurrentRadioIndex() return self.index end
function car:ToggleRadioReceiver(on) self.on = on; self.log[#self.log + 1] = 'toggle:' .. tostring(on) end
function car:SetRadioReceiverStation(index) self.index = index; self.log[#self.log + 1] = 'station:' .. index end
function car:GetEntityID() return {hash = self.hash} end
local mounted = car
local npc = {IsAttached = function() return true end, GetEntityID = function() return 'npc-id' end}
local player = {GetMountedVehicle = function() return mounted end}
Game = {GetPlayer = function() return player end, GetAudioSystem = function() return audio end,
  GetRadioStationLocalizedName = function(i) return stations[i] end,
  GetTargetingSystem = function() return {GetCrosshairData = function() return {x = 1, y = 2, z = 3}, {x = 0, y = 1, z = 0} end} end}
CName = {new = function(v) return v end}
local world = W.new({log = log, companions = {conversationCandidates = function() return {{profileKey = 'panam-palmer', npc = npc}} end}})
local pose = world.cameraPose()
assert(pose.x == 1 and pose.y == 2 and pose.z == 3 and pose.fx == 0 and pose.fy == 1)
-- the radio: by name (case and spaces do not matter), on if it was off, given back
local token = world.radioSwitch('radio pebkac')
assert(token and token.wasOn == false and token.index == 1 and car.on == true and car.index == 1, tostring(car.index))
local token2 = world.radioSwitch('Impulse 99.9', token)
assert(token2 == token and car.index == 2 and token.wasOn == false, 'the state to give back stays the first one')
assert(world.radioRestore(token) and car.on == false)
assert(select(2, world.radioSwitch('No Such Station')) == 'no station named No Such Station')
mounted = nil
assert(select(2, world.radioSwitch('Impulse 99.9')) == 'V is on foot')
mounted = car; car.on = true; car.index = 3
local t = world.radioSwitch('Impulse 99.9')
mounted = {GetEntityID = function() return {hash = '99'} end}
assert(world.radioRestore(t) == false, 'another vehicle: nothing is touched')
assert(select(2, world.radioRestore(nil)) == 'no token')
-- game sounds: flat, or on the copy
local flat = world.gamePlay('ui_jingle')
assert(flat.event == 'ui_jingle' and flat.id == nil and audio.plays[1] == 'ui_jingle')
local onCopy = world.gamePlay('ono_v_laugh', 'panam-palmer')
assert(onCopy.id == 'npc-id' and audio.plays[2] == 'ono_v_laugh@npc-id')
assert(select(2, world.gamePlay('ono_v_laugh', 'someone-else')) == 'the copy is not here')
assert(select(2, world.gamePlay('bad name!')) == 'bad event')
assert(world.gameStop(flat) and audio.stops[1] == 'ui_jingle')
assert(world.gameStop(onCopy) and audio.stops[2] == 'ono_v_laugh@npc-id')
assert(world.gameStop(nil) == false)
`));
