// The facts reader of the bond quests, the game half (mod/quest-facts.lua, docs/QUEST_PRIMITIVES.md section 10.9): the named game facts a pack gate wants, read with the quest
// system and written to runtime/quest-facts.json only when a value changed, at session start, after a world change and every 300 seconds, never faster. Run on a fake game:
// a clock, a table of fact values and files in memory. Nothing here starts the game.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run, load, base} from './quest-lua-fixture.mjs';

const harness = `
local Facts = ${load('quest-facts.lua')}
${base}
local game = {now = 1000, gameClock = 77000, values = {}, reads = {}, files = {}, writes = 0, on = true, wanted = nil, writeFails = false, throwFact = false}
local rows = {
  {id = 'takemura-alive', names = {'q105_takemura_alive', 'q105_takemura_rescued'}, kind = 'bool'},
  {id = 'path', names = {'q_path_nomad', 'q_path_street', 'q_path_corpo'}, kind = 'enum', values = {'nomad', 'street', 'corpo'}},
  {id = 'plain', names = {'q_a', 'q_b'}, kind = 'enum'},
}
game.wanted = rows
local reader = Facts.new({
  enabled = function() return game.on end, wanted = function() return game.wanted end, clock = function() return game.now end, gameTime = function() return game.gameClock end,
  fact = function(name) game.reads[#game.reads + 1] = name; if game.throwFact then error('no quest system') end return game.values[name] end,
  read = function(path) return game.files[path] end,
  write = function(path, text) if game.writeFails then return false end game.files[path] = text; game.writes = game.writes + 1; return true end,
  encode = serialize, decode = decode, log = log})
-- One call a second (whole seconds keep the arithmetic exact). The real tick calls it every 0.1 s, the reader only adds the delta.
local function tick(seconds)
  for _ = 1, math.floor(seconds + 0.5) do game.now = game.now + 1; game.gameClock = game.gameClock + 1; reader.update(1) end
end
local function filed() return game.files[Facts.FILE] and decode(game.files[Facts.FILE]) or nil end
`;
const withGame = code => run(`${harness}\n${code}`);

test('the first look reads every wanted fact and writes {version, at, facts} with a bool and an enum value', () => withGame(`
game.values.q105_takemura_rescued = 1
game.values.q_path_street = 2
reader.update(5)
local f = filed()
assert(f and f.version == 1 and f.at == 77000, 'stamped with the game clock')
assert(f.facts['takemura-alive'] == true, 'any name above zero')
assert(f.facts.path == 'street', 'the value text of the first name above zero')
assert(f.facts.plain == '', 'an enum with nothing set is empty')
assert(game.writes == 1 and Facts.FILE == 'runtime/quest-facts.json')
`));

test('bool: false when no name is above zero, true when any is; enum: the first set name wins, a value list maps it, no list gives the name', () => withGame(`
reader.update(5)
assert(filed().facts['takemura-alive'] == false and filed().facts.path == '' and filed().facts.plain == '')
game.values.q105_takemura_alive = 1; game.values.q_path_corpo = 1; game.values.q_path_nomad = 1; game.values.q_b = 3
tick(300)
local f = filed().facts
assert(f['takemura-alive'] == true and f.path == 'nomad' and f.plain == 'q_b', f.path .. ' ' .. f.plain)
game.values.q105_takemura_alive = 0; game.values.q105_takemura_rescued = 0
tick(300); assert(filed().facts['takemura-alive'] == false)
`));

test('the file is written only when a value changed; the same values again write nothing', () => withGame(`
game.values.q105_takemura_alive = 1
reader.update(5); assert(game.writes == 1)
tick(300); tick(300); tick(300)
assert(game.writes == 1, 'three more reads, the same values: ' .. game.writes)
game.values.q_path_street = 1
tick(300); assert(game.writes == 2 and filed().facts.path == 'street')
tick(300); assert(game.writes == 2)
-- A new wanted fact is a change, and so is a dropped one.
game.wanted = {rows[1]}
tick(300); assert(game.writes == 3)
local f = filed().facts
assert(f['takemura-alive'] == true and f.path == nil)
`));

test('cadence: the first look reads at once, then once per 300 s of the clock, never faster, however often it is called', () => withGame(`
reader.update(5)
local once = #game.reads
assert(once == 7, 'seven names read once: ' .. once)
tick(290); assert(#game.reads == once, 'nothing before 300 s: ' .. #game.reads)
tick(9); assert(#game.reads == once, 'still nothing at 299 s')
tick(5); assert(#game.reads == 2 * once, 'one read after 300 s: ' .. #game.reads)
-- Called a thousand times in one instant: the clock decides, not the number of calls.
for _ = 1, 1000 do reader.update(5) end
assert(#game.reads == 2 * once, 'no extra read: ' .. #game.reads)
`));

test('a call is cheap: it adds the delta and looks only every 5 s, so the setting, the list and the clock are not read on every tick', () => withGame(`
local counts = {clock = 0, enabled = 0, wanted = 0}
local counted = Facts.new({enabled = function() counts.enabled = counts.enabled + 1; return true end, wanted = function() counts.wanted = counts.wanted + 1; return rows end,
  clock = function() counts.clock = counts.clock + 1; return game.now end, fact = function() return 0 end, read = function() return nil end, write = function() return true end,
  encode = serialize, decode = decode})
counted.update(5)   -- the session start look
local before = counts.enabled
for _ = 1, 49 do counted.update(0.1) end
assert(counts.enabled == before and counts.wanted == 2 and counts.clock == 1 + 0, 'nothing is read between looks: ' .. counts.enabled .. '/' .. counts.wanted .. '/' .. counts.clock)
counted.update(0.2)
assert(counts.enabled == before + 1, 'one look after 5 s')
`));

test('nothing wanted, or the setting off, reads nothing and writes nothing; turning the setting on later reads at the next look', () => withGame(`
game.wanted = nil
tick(30); assert(#game.reads == 0 and game.writes == 0)
game.wanted = {}
tick(30); assert(#game.reads == 0 and game.writes == 0, 'an empty list is nothing')
game.wanted = rows; game.on = false
tick(30); assert(#game.reads == 0 and game.writes == 0, 'the setting is off')
game.on = true; game.values.q105_takemura_alive = 1
tick(5.2); assert(#game.reads > 0 and game.writes == 1 and filed().facts['takemura-alive'] == true)
`));

test('a world change reads again at the next look, and writes only if the world says something else', () => withGame(`
game.values.q105_takemura_alive = 1
reader.update(5); assert(game.writes == 1)
local reads = #game.reads
reader.reset(); tick(5.2)
assert(#game.reads == 2 * reads, 'read again after the reset: ' .. #game.reads)
assert(game.writes == 1, 'same values, no write')
reader.reset(); game.values.q105_takemura_alive = 0; tick(5.2)
assert(game.writes == 2 and filed().facts['takemura-alive'] == false)
-- After the reset the 300 s count starts again from that read.
local before = #game.reads
tick(285); assert(#game.reads == before, 'not yet: ' .. #game.reads - before)
tick(20); assert(#game.reads >= before + 6 and #game.reads <= before + 7, 'one more read: ' .. #game.reads - before)
`));

test('session start: a file with the same values counts as written, one with other values is replaced, a broken file is no file', () => withGame(`
game.files[Facts.FILE] = serialize({version = 1, at = 5, facts = {['takemura-alive'] = false, path = '', plain = ''}})
reader.update(5); assert(game.writes == 0, 'same as the file: no write')
local function make(fact, decodeFn)
  return Facts.new({enabled = function() return true end, wanted = function() return rows end, clock = function() return game.now end, gameTime = function() return 1 end,
    fact = fact, read = function(path) return game.files[path] end,
    write = function(path, text) game.files[path] = text; game.writes = game.writes + 1; return true end, encode = serialize, decode = decodeFn or decode})
end
make(function(name) return name == 'q_path_nomad' and 1 or 0 end).update(5)
assert(game.writes == 1 and filed().facts.path == 'nomad' and filed().at == 1)
game.files[Facts.FILE] = 'not a table'
make(function() return 0 end, function() error('bad json') end).update(5)
assert(game.writes == 2)
`));

test('a write that fails is tried again at the next read, a quest system that raises reads as zero, and a bad row of the list is skipped', () => withGame(`
game.writeFails = true; game.values.q105_takemura_alive = 1
reader.update(5); assert(game.writes == 0 and filed() == nil)
game.writeFails = false
tick(290); assert(game.writes == 0, 'not before the next read')
tick(15); assert(game.writes == 1 and filed().facts['takemura-alive'] == true)
game.throwFact = true
tick(300); assert(game.writes == 2 and filed().facts['takemura-alive'] == false, 'an unreadable fact is no')
game.throwFact = false
game.wanted = {'junk', {id = 5, names = {'x'}}, {id = 'ok', names = {'q_a'}, kind = 'bool'}, {id = 'nonames', kind = 'bool'}}
game.values.q_a = 1
tick(300); assert(filed().facts.ok == true and filed().facts.nonames == nil)
`));

test('without options the reader is inert: nothing wanted, setting off, no clock, and it never raises', () => run(`
local Facts = ${load('quest-facts.lua')}
local r = Facts.new()
r.update(10); r.update(nil); r.reset(); assert(r.readNow() == false)
assert(type(r.status()) == 'table')
`));
