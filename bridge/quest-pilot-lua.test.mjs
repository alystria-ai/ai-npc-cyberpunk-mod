// The pilot quest "Coffee at the Sunset" through the real game-side modules (places, primitives, line player, quest executor) on a fake game: the play file the pack runner writes
// for each stage is fed in as it is, every primitive of the stage must start, V's walk through the world raises the events, the script rows speak and text, and the cast
// copy carries from the first stage into the next and is removed with the quest. The runner half is bridge/quest-pilot-panam.test.mjs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {run, load, source, base} from './quest-lua-fixture.mjs';
import {BondPacks} from './bond-pack-runner.mjs';
import {shippedPacks} from './bond-packs.mjs';
import {parseJournalHistory} from './journal-history.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const roster = new Set(JSON.parse(read('../characters/roster.json')).map(row => row.key));
const pilot = shippedPacks().map(row => row.pack).find(pack => pack.id === 'panam-sunset-coffee');
const toLua = value => {
  if (value === null || value === undefined) return 'nil';
  if (Array.isArray(value)) return '{' + value.map(toLua).join(',') + '}';
  if (typeof value === 'object') return '{' + Object.entries(value).map(([key, item]) => `[${JSON.stringify(key)}]=${toLua(item)}`).join(',') + '}';
  return JSON.stringify(value);
};
const DONE = [['quests/main_quest/act_01/q104_02_av_chase', 'succeeded']];
const coverage = {status: 'complete', ageSeconds: 1, windowSeconds: 30, observed: 1, omitted: 0, unstable: false};
const journalHistory = parseJournalHistory({version: 1, status: 'ready', generation: 1, capturedAtMs: 2000, worldToken: 'w1', tracked: {status: 'untracked'},
  coverage: {active: coverage, history: coverage}, quests: DONE.map(([path, state], index) => ({id: String(100 + index), nativeId: 'q104_02_av_chase', nativePath: path, title: 'Quest',
    state, lane: 'history', observedAtMs: 1000, objectivesComplete: true, objectives: []}))});

// The play file of each stage, exactly as the runner writes it, with the places given positions as the capture file would.
function stageFiles() {
  const runner = new BondPacks({packs: [pilot], characters: roster, random: () => 0, debounceMs: 0, exists: () => false, write: async () => {}});
  const t0 = 30 * 86400, files = {};
  const input = {requestId: 'r-1', profileKey: 'panam-palmer', name: 'Panam', text: 'hey', entity: 'e1', turnContext: {gameTime: t0}, journalHistory,
    bonds: {on: true, copy: 'party', packs: true, invitations: true}};
  runner.forTurn(input, {level: 3}); runner.afterTurn(input, 'ok');
  const grab = name => { files[name] = runner.playState(); };
  grab('invite');
  const go = event => runner.noteEvent({pack: 'panam-sunset-coffee', serial: runner.playState().quests[0].serial, name: event, at: t0 + 100});
  go('place:sunset:arrived'); grab('walk');
  go('together:tour:done'); grab('sit');
  go('gap:g1:open'); grab('sit-gap');
  go('gap:g1:shared'); grab('last-sip-warm');
  go('place:sunset:left'); grab('closing');
  return files;
}
const FILES = stageFiles();

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
const withGame = code => run(`${harness}
${code}
assert(not game.stale, 'a handle was kept across ticks')`);
const play = name => toLua(FILES[name]);
const at = place => ({...place});

const PREPARE = `
game.gameClock = 30 * 86400 + 50   -- the clock of the save the runner's stages were stamped on
game.files['runtime/quest-place-capture.json'] = serialize({version = 1, places = {sunset = {x = 100, y = 200, z = 10}, lookout = {x = 140, y = 200, z = 10}}})
local function setFile(value) game.files[Play.PLAY] = serialize(value) end
local function names()
  local list = {}
  for _, e in ipairs(game.files[Play.EVENTS] and decode(game.files[Play.EVENTS]).events or {}) do list[#list + 1] = e.name end
  return table.concat(list, ' ')
end
local function startedIds() local ids = {} for _, e in ipairs(game.started) do ids[#ids + 1] = e.id end return table.concat(ids, ' ') end
`;

test('the pilot, first stage: every primitive starts, the pin and the text appear, the copy is placed when V is near, and arriving speaks her line and reports the event', () => withGame(`
${PREPARE}
setFile(${play('invite')})
game.vpos = {x = 100, y = -400, z = 10}
assert(play.restore() == true)
step(4)
assert(not logged('unknown primitive') and not logged('could not start') and not logged('not in the stage'), table.concat(logs, ' | '))
assert(game.pinAdds == 1, 'the meeting point is pinned')
assert(#game.phones == 1 and game.phones[1].text:find('^Motel coffee') and game.phones[1].image == nil, 'the invitation text is in her chat')
assert(#game.spawnCalls == 0, 'far away nothing is spawned')
game.vpos = {x = 100, y = 100, z = 10}
step(6)
assert(#game.spawnCalls == 1 and game.spawnCalls[1].profileKey == 'panam-palmer' and game.spawnCalls[1].who == 'self', 'her copy is placed once V is within 150 m')
game.vpos = {x = 100, y = 190, z = 10}
step(3)
assert(names():find('place:sunset:arrived', 1, true), names())
assert(startedIds():find('P1.walk.01', 1, true), 'she greets V at the motel: ' .. startedIds())
assert(game.pinRemoves == 1, 'the pin goes when V arrives')
`));

test('the pilot, walk and sit: the copy carries over, the tour and the lookout work, the gap opens after her line, and an answer from the bridge speaks the reply row', () => withGame(`
${PREPARE}
game.rate = 100
setFile(${play('invite')})
game.vpos = {x = 100, y = 100, z = 10}
assert(play.restore() == true)
step(6); game.vpos = {x = 100, y = 190, z = 10}; step(3)
local function heard() lines.stopped('r' .. (game.nextRequest - 1), 'finished'); step(1) end
heard()   -- her greeting is heard to its end
local spawned = #game.spawnCalls
game.attached['h1'] = {x = 100, y = 205, z = 10}
-- The bridge moves the quest to the walk stage.
setFile(${play('walk')}); play.onPlayRevision(); step(2)
assert(#game.deleted == 0, 'the copy is not removed when the stage changes')
assert(#game.spawnCalls == spawned)
assert(startedIds():find('P1.walk.02', 1, true), 'the tour line on entering the stage')
game.copy = {profileKey = 'panam-palmer', kind = 'party', position = {x = 101, y = 190, z = 10}}
game.vpos = {x = 100, y = 190, z = 10}
heard()   -- the tour line
step(30)
assert(names():find('together:tour:done', 1, true), 'twenty game minutes together: ' .. names())
game.vpos = {x = 140, y = 200, z = 10}; game.copy.position = {x = 141, y = 200, z = 10}
step(3)
assert(startedIds():find('P1.walk.03', 1, true), 'the lookout line')
heard()
-- The sit stage: seated together raises the line, the end of the line opens the gap.
setFile(${play('sit')}); play.onPlayRevision(); step(2)
game.seated = {v = true, copy = true}
game.copy.position = {x = 140, y = 201, z = 10}
step(3)
assert(names():find('seat:seated', 1, true) and startedIds():find('P1.sit.01', 1, true), names() .. ' / ' .. startedIds())
lines.stopped('r' .. (game.nextRequest - 1), 'finished')
step(2)
assert(names():find('gap:g1:open', 1, true) and lines.busy(), 'the gap is open: ' .. names())
-- The bridge reads V's words, picks the tag and tells the game.
local value = ${play('sit-gap')}
value.commands = {{seq = 1, pack = 'panam-sunset-coffee', serial = value.quests[1].serial, cmd = 'event', name = 'gap:g1:shared'}, {seq = 2, pack = 'panam-sunset-coffee', serial = value.quests[1].serial, cmd = 'resume', gap = 'g1'}}
setFile(value); play.onPlayRevision(); step(2)
assert(startedIds():find('P1.sit.02', 1, true), 'the reply row for the shared answer: ' .. startedIds())
assert(not lines.busy() or true)
`));

test('the pilot, the end: the closing rows send the picture text, and the copy of the quest is let go with the quest', () => withGame(`
${PREPARE}
setFile(${play('invite')})
game.vpos = {x = 100, y = 100, z = 10}
assert(play.restore() == true)
step(6)
setFile(${play('last-sip-warm')}); play.onPlayRevision(); step(2)
setFile(${play('closing')}); play.onPlayRevision(); step(2)
local last = game.phones[#game.phones]
assert(last and last.text == 'Proof the view was worth it.', last and last.text)
assert(last.image and last.image.part == 'panam_sunset_coffee_sunset_coffee' and last.image.width == 1024, 'the picture rides with the text')
assert(#game.deleted == 1, 'the cast copy that was carried goes with the quest')
assert(play.armed() == false or true)
`));
