// Music and TV, the two live gaps of 2026-10-25 (docs/DYNAMIC_INFO.md "Music and TV"): the song name and finding a TV that is on.
// - The song: the track CName had a hash but no text in CET's name pool (probe.log `trackWhy=none:` with nothing after it), and the resolver gave
//   up on an empty name before asking the game to localise it. Now it localises by the hash; the game's own song-change events
//   (mod/media-song.lua) are a second source, cached and read at the turn.
// - The TV: the targeting query does not list TVs (probe.log `parts=13 objects=3 seen=NPCPuppet:2,GenericDevice:1` beside a TV that was on), so the
//   TV that spoke a subtitle line is remembered by its EntityID (mod/game-dialogue.lua) and looked up with FindEntityByID.
// Strict fakes: a CName is an object with hash_hi/hash_lo (never a plain string where the game hands a CName), an EntityID is a tagged object
// that FindEntityByID checks, and the observer checks its class and method names against the list the game scripts have.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const mediaSource = read('../mod/media-context.lua');
const songSource = read('../mod/media-song.lua');
const dialogueSource = read('../mod/game-dialogue.lua');
const init = read('../mod/init.lua');

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  try {
    const result = lauxlib.luaL_dostring(state, to_luastring(code));
    const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
    const at = Number(/\]:(\d+):/.exec(error)?.[1]);
    assert.equal(result, lua.LUA_OK, error + (at ? '\n' + code.split('\n')[at - 1] : ''));
  } finally { lua.lua_close(state); }
}

// CET's CName: a hash, and text only when the name is in the pool. NameToString gives '' for a name it does not know; tostring prints the text
// in a comment, empty for an unknown name. EntityID: tagged, so a plain table or a hash string passed in its place is caught.
const fakes = `
local POOL = {}
local CNameMeta = {__tostring = function(self) return 'ToCName{ hash_lo = ' .. self.hash_lo .. ', hash_hi = ' .. self.hash_hi .. ' --[[ ' .. ((self.hash_lo == 0 and self.hash_hi == 0) and 'None' or POOL[self.hash_lo] or '') .. ' --]] }' end,
  __eq = function(a, b) return a.hash_lo == b.hash_lo and a.hash_hi == b.hash_hi end}
local function cname(hi, lo, text) if text then POOL[lo] = text end return setmetatable({hash_hi = hi, hash_lo = lo}, CNameMeta) end
local NONE = cname(0, 0)
Game = {NameToString = function(value)
  assert(getmetatable(value) == CNameMeta, 'NameToString takes a CName')
  if value.hash_lo == 0 and value.hash_hi == 0 then return 'None' end
  return POOL[value.hash_lo] or ''
end}
local EntityIDMeta = {}
local function entityID(hash) return setmetatable({hash = hash}, EntityIDMeta) end
`;

// ---- the song: a CName with a hash and no text -------------------------------------------------------------------------------------------------
const mediaPrelude = `
${fakes}
local M = (function() ${mediaSource} end)()
local STATION = cname(1, 11, 'Gameplay-Devices-Radio-RadioStationHipHop')
local SONG = cname(7, 77)            -- the song: a real hash, no text in the pool
local W = {track = SONG, cached = nil, cachedWhy = 'event:none', localized = {[11] = '101.9 The Dirge', [77] = 'Dirge Anthem'}}
local logs, asked = {}, {}
local N = {
  vehicle = function() return nil end,
  pocket = function() return {} end, pocketActive = function() return true end,
  pocketStation = function() return STATION end, pocketTrack = function() return W.track end, pocketIndex = function() return 3 end,
  trackByIndex = function() return NONE end,
  localizeKey = function(value)
    assert(getmetatable(value) == CNameMeta, 'GetLocalizedTextByKey is handed the CName itself, never its empty text')
    asked[#asked + 1] = value.hash_lo
    return W.localized[value.hash_lo] or ''
  end,
  localizeText = function(text) return '' end,
  cachedSong = function(station) W.askedStation = station; return W.cached, W.cachedWhy end,
  tvLookAt = function() return nil end, tvQuery = function() return {}, {parts = 0, objects = 0, classes = ''} end, tvLine = function() return nil end,
  log = function(line) logs[#logs + 1] = line end}
local reader = M.new({native = N})
`;
const media$ = body => run(mediaPrelude + '\n' + body);

test('a song CName with a hash and no text is localised by its hash, as the game\'s own now-playing toast does', () => media$(`
  assert(M.nameText(SONG) == '', 'CET cannot print it: the cause of trackWhy=none: in the live log')
  local result = reader:read({})
  assert(result.radio.station == '101.9 The Dirge' and result.radio.track == 'Dirge Anthem', tostring(result.radio.track))
  assert(logs[#logs]:find('track=[#000000070000004d]->[Dirge Anthem](ByKey)', 1, true), logs[#logs])
  assert(not logs[#logs]:find('trackWhy', 1, true))
`));

test('a None CName is no song, and an unknown hash that the game cannot localise is unresolved, with the reason in codes', () => media$(`
  W.track = NONE
  local result = reader:read({})
  assert(result.radio.track == nil and result.radio.station == '101.9 The Dirge')
  assert(logs[#logs]:find('trackWhy=none:None event:none', 1, true), logs[#logs])
  W.track, W.localized[77] = SONG, nil
  result = reader:read({})
  assert(result.radio.track == nil)
  assert(logs[#logs]:find('track=[#000000070000004d]->[nil](unresolved)', 1, true), logs[#logs])
  assert(logs[#logs]:find('trackWhy=none:#000000070000004d event:none', 1, true), logs[#logs])
`));

test('the song from the game\'s song-change event fills in when the receiver gives none; it is asked for the station tuned now', () => media$(`
  W.track = NONE
  W.cached, W.cachedWhy = SONG, 'event'
  local result = reader:read({})
  assert(result.radio.track == 'Dirge Anthem')
  assert(W.askedStation == 'Gameplay-Devices-Radio-RadioStationHipHop', tostring(W.askedStation))
  assert(logs[#logs]:find('(event/ByKey)', 1, true), logs[#logs])
  -- the cache says why it has nothing: those codes reach probe.log
  W.cached, W.cachedWhy = nil, 'event:otherStation'
  reader:read({})
  assert(logs[#logs]:find('trackWhy=none:None event:otherStation', 1, true), logs[#logs])
  -- a cached song the game cannot localise
  W.cached, W.cachedWhy, W.localized[77] = SONG, 'event', nil
  reader:read({})
  assert(logs[#logs]:find('event:unresolved', 1, true), logs[#logs])
`));

test('without the song module (switch never on) the read is today\'s station-only line, and no cache is asked through a missing global', () => run(`
  ${fakes}
  local M = (function() ${mediaSource} end)()
  local N = M.adapter()
  convaiMediaSong = nil
  local song, why = N.cachedSong('x')
  assert(song == nil and why == 'event:off')
  convaiMediaSong = false
  song, why = N.cachedSong('x')
  assert(song == nil and why == 'event:off')
`));

// ---- mod/media-song.lua --------------------------------------------------------------------------------------------------------------------------
const songPrelude = `
${fakes}
local S = (function() ${songSource} end)()
local known = {
  VehicleSummonWidgetGameController = {OnVehicleRadioSongChanged = true},
  VehicleRadioPopupGameController = {OnVehicleRadioSongChanged = true},
  PlayerPuppet = {OnVehicleRadioStationChanged = true}}
local hooks, logs, now, on, station = {}, {}, 1000, true, nil
local function observe(class, method, fn)
  if not (known[class] and known[class][method]) then error('no such method: ' .. class .. '.' .. method) end
  hooks[class .. '.' .. method] = fn
end
local N = {songOf = function(evt) return evt.radioSongName end, stationOf = function(evt) return evt.radioStationName end,
  station = function() return station end}
local songs = S.new({observe = observe, wanted = function() return on end, now = function() return now end, native = N,
  log = function(line) logs[#logs + 1] = line end})
local HIPHOP, POP = cname(1, 11, 'Gameplay-Devices-Radio-RadioStationHipHop'), cname(1, 12, 'Gameplay-Devices-Radio-RadioStationPop')
local SONG, OTHER = cname(7, 77), cname(7, 78)
local function songEvent(name) return {radioSongName = name} end
`;
const song$ = body => run(songPrelude + '\n' + body);

test('media-song: the three events the game scripts have are hooked, each once; a second install hooks nothing more', () => song$(`
  assert(songs:song('x') == nil and select(2, songs:song('x')) == 'event:off', 'not installed: off')
  assert(songs:install() == 3)
  assert(hooks['VehicleSummonWidgetGameController.OnVehicleRadioSongChanged'] and hooks['VehicleRadioPopupGameController.OnVehicleRadioSongChanged']
    and hooks['PlayerPuppet.OnVehicleRadioStationChanged'])
  local count = 0; for _ in pairs(hooks) do count = count + 1 end
  hooks = {}
  assert(songs:install() == 3 and next(hooks) == nil, 'idempotent')
  assert(#logs == 0)
`));

test('media-song: a class or event that does not exist logs once and does nothing; the others still hook', () => song$(`
  known.VehicleRadioPopupGameController = nil
  assert(songs:install() == 2)
  assert(#logs == 1 and logs[1]:find('VehicleRadioPopupGameController.OnVehicleRadioSongChanged could not be hooked', 1, true), logs[1])
  local bare = S.new({wanted = function() return true end, log = function(line) logs[#logs + 1] = line end})
  assert(bare:install() == 0 and logs[#logs]:find('no observer', 1, true))
`));

test('media-song: a song change stores the song and the station tuned then; it is valid for that station for six minutes', () => song$(`
  songs:install()
  station = HIPHOP
  hooks['VehicleSummonWidgetGameController.OnVehicleRadioSongChanged'](nil, songEvent(SONG))
  local key = 'Gameplay-Devices-Radio-RadioStationHipHop'
  local value, why = songs:song(key)
  assert(value == SONG and why == 'event')
  now = now + S.MAX_AGE
  assert(songs:song(key) == SONG, 'still playing at the limit')
  now = now + 1
  value, why = songs:song(key)
  assert(value == nil and why == 'event:old')
  -- the radio was turned to another station since
  hooks['VehicleRadioPopupGameController.OnVehicleRadioSongChanged'](nil, songEvent(OTHER))
  value, why = songs:song('Gameplay-Devices-Radio-RadioStationPop')
  assert(value == nil and why == 'event:otherStation')
  assert(songs:song(key) == OTHER)
`));

test('media-song: a station change carries its own song; an empty song (the radio switched on) clears the old one; a None song is no song', () => song$(`
  songs:install()
  station = nil   -- the receiver is not readable at that moment: the event's own station is used
  hooks['PlayerPuppet.OnVehicleRadioStationChanged'](nil, {radioSongName = SONG, radioStationName = POP, radioIndex = 4, isActive = true})
  assert(songs:song('Gameplay-Devices-Radio-RadioStationPop') == SONG)
  hooks['VehicleSummonWidgetGameController.OnVehicleRadioSongChanged'](nil, songEvent(nil))
  local value, why = songs:song('Gameplay-Devices-Radio-RadioStationPop')
  assert(value == nil and why == 'event:empty')
  hooks['VehicleSummonWidgetGameController.OnVehicleRadioSongChanged'](nil, songEvent(NONE))
  assert(select(2, songs:song('x')) == 'event:empty')
`));

test('media-song: with the switch off a callback does nothing past one boolean read, and a raising read never escapes the game event', () => song$(`
  songs:install()
  on = false
  local reads = 0
  N.songOf = function(evt) reads = reads + 1; return evt.radioSongName end
  hooks['VehicleSummonWidgetGameController.OnVehicleRadioSongChanged'](nil, songEvent(SONG))
  assert(reads == 0 and songs.last == nil)
  on = true
  N.songOf = function() error('boom') end
  N.station = function() error('boom') end
  hooks['VehicleSummonWidgetGameController.OnVehicleRadioSongChanged'](nil, songEvent(SONG))
  assert(select(2, songs:song('x')) == 'event:empty')
`));

test('media-song: no per-frame work, no timer, no write; only ObserveAfter through the injected observer', () => {
  assert.doesNotMatch(songSource, /registerForEvent|onUpdate|io\.open|os\.remove|Override\(|ObserveBefore\(|:Set[A-Z]|Cron/);
  assert.doesNotMatch(songSource, /\bObserve(After)?\(/, 'the observer is injected (init.lua passes ObserveAfter)');
});

// ---- the TV that spoke ------------------------------------------------------------------------------------------------------------------------
test('a TV that spoke is found by its EntityID with no search; it must still be near and on; probe.log says why when it is not', () => run(`
  ${fakes}
  local M = (function() ${mediaSource} end)()
  local TV_ID = entityID(42)
  local tvEntity = {distance = 4, state = {on = true, key = 'ch_news', index = 1}}
  local W = {heard = TV_ID, class = 'TV', entity = tvEntity}
  local logs, calls = {}, {}
  local N = {vehicle = function() return nil end, pocket = function() return nil end, tvLookAt = function() return nil end,
    tvHeard = function(maxAge) assert(maxAge == M.TV_MEMORY); return W.heard, 3, W.class end,
    entityById = function(id) assert(getmetatable(id) == EntityIDMeta, 'FindEntityByID takes the EntityID'); return W.entity end,
    distance = function(_, entity) return entity.distance end, tvState = function(entity) return entity.state end,
    tvQuery = function() calls.query = (calls.query or 0) + 1; return {}, {parts = 13, objects = 3, classes = 'NPCPuppet:2,GenericDevice:1'} end,
    localizeKey = function(value) return ({ch_news = 'N54 News'})[value] end, tvLine = function() return 'The weather is mild.' end,
    log = function(line) logs[#logs + 1] = line end}
  local reader = M.new({native = N})
  local result = reader:read({})
  assert(result.tv.channel == 'N54 News' and result.tv.said == 'The weather is mild.')
  assert(calls.query == nil, 'found by ID: no query')
  assert(logs[#logs]:find('tv=speaker', 1, true), logs[#logs])
  -- off, or walked away from: the query still runs, and the reason is in the line
  tvEntity.state = {on = false}
  N.tvLine = function() return nil end
  assert(reader:read({}) == nil and calls.query == 1)
  assert(logs[#logs]:find('heardTv=farOrOff tvSpeaker=TV', 1, true), logs[#logs])
  W.entity = nil
  M.new({native = N}):read({})
  assert(logs[#logs]:find('heardTv=gone', 1, true), logs[#logs])
  -- a TV line whose speaker was not a TV: the class is told, nothing is looked up
  W.heard, W.class = nil, 'none'
  reader = M.new({native = N})
  reader:read({})
  assert(logs[#logs]:find('tvSpeaker=none', 1, true) and not logs[#logs]:find('heardTv', 1, true), logs[#logs])
`));

const dialoguePrelude = `
${fakes}
local api = (function() ${dialogueSource} end)()
local now = 1000
local N = {player = function() return {id = '99ULL'} end, ready = function(p) return p ~= nil end, entity = function(o) return o.id end,
  braindance = function() return false end, replacer = function() return false end, playerCombat = function() return false end,
  npcCombat = function() return false end, isVehicle = function(o) return o.vehicle == true end, call = function() return nil end,
  lineType = function(value) return value end, text = function(line) return line.text end,
  speakerName = function(line) return line.speakerName end, lineId = function(line) return tostring(line.id) end,
  lineNumber = function(line) return tonumber(line.id) end, fromVariant = function(value) return value end,
  dialogChoice = function() return false end, activeHub = function() return 0 end, localized = function(text) return text end,
  subtitles = function() return {serial = 0} end}
local dialogue = api.new({native = N, now = function() return now end, enabled = function() return true end, heardWanted = function() return true end,
  resolve = function() return nil end, resolveName = function() return nil end, contactKey = function() return nil end, present = function() return {} end})
local nextId = 100
local function say(kind, text, speaker) nextId = nextId + 1; return dialogue:line({id = nextId, type = kind, speaker = speaker, text = text}, 'show') end
`;

test('game-dialogue: the default adapter tells a TV speaker by class or by its controller, and hands back the EntityID itself', () => run(`
  ${dialoguePrelude}
  local id = entityID(42)
  local function speaker(class, controller)
    return {GetClassName = function() return cname(3, #class, class) end, IsA = function(_, name) return name == class end,
      GetEntityID = function() return id end,
      GetDevicePS = function() if controller == nil then error('not a device') end return {IsA = function(_, name) return name == controller end} end}
  end
  -- the adapter is local to the module: reach it through a dialogue built without a native override
  local real = api.new({now = function() return now end, heardWanted = function() return true end})
  local source = real.native.tvSource({speaker = speaker('TV')})
  assert(source.class == 'TV' and source.id == id and getmetatable(source.id) == EntityIDMeta)
  source = real.native.tvSource({speaker = speaker('Screen', 'TVControllerPS')})
  assert(source.id == id and source.class == 'Screen')
  source = real.native.tvSource({speaker = speaker('NPCPuppet')})
  assert(source.id == nil and source.class == 'NPCPuppet')
  assert(real.native.tvSource({speaker = nil}) == nil)
`));

test('game-dialogue: a TV line remembers which TV said it; heardTv answers by age; a reset for another reason forgets it', () => run(`
  ${dialoguePrelude}
  local TV_ID = entityID(42)
  N.tvSource = function(line) if line.speaker then return {id = line.speaker.tv and TV_ID or nil, class = line.speaker.class} end end
  say('GlobalTV', 'The weather is mild tonight.', {tv = true, class = 'TV'})
  local id, age, class = dialogue:heardTv(60)
  assert(id == TV_ID and age == 0 and class == 'TV')
  -- a later line from something that is not a TV keeps the TV, and tells what spoke
  now = now + 10
  say('GlobalTV', 'Buy now.', {class = 'Billboard'})
  id, age, class = dialogue:heardTv(60)
  assert(id == TV_ID and age == 10 and class == 'Billboard')
  now = now + 100
  id, age, class = dialogue:heardTv(60)
  assert(id == nil and class == nil, 'too old')
  assert(dialogue:heardTv(1800) == TV_ID)
  -- ordinary dialogue lines are not TV lines: nothing is read from their speaker
  local reads = 0
  N.tvSource = function() reads = reads + 1 end
  say('Regular', 'Hey, V.', {class = 'NPCPuppet'})
  assert(reads == 0)
  dialogue:reset('load')
  assert(dialogue:heardTv(1800) == nil)
`));

// ---- the wiring in init.lua -------------------------------------------------------------------------------------------------------------------
test('init.lua: the song hooks are installed only while Music and TV is on, at start or at the first turn, once; a failed load is not retried', () => {
  const start = init.indexOf('convaiMediaSongInstall = function()');
  const end = init.indexOf('\nend\n', start);
  assert.ok(start > 0 && end > start);
  const installer = init.slice(start, end + 5);
  assert.match(init, /convaiGuarded\('Media song hooks', convaiMediaSongInstall\)/);
  assert.match(init, /if convaiMediaSong == nil then convaiMediaSongInstall\(\) end/);
  run(`
    local on, loads, observed, broken = false, 0, {}, false
    manager = {dynamicInfo = function(kind) assert(kind == 'media'); return on end}
    ObserveAfter = function(class, method) observed[#observed + 1] = class .. '.' .. method end
    convaiLogOnce = function() end
    function dofile(path)
      assert(path == 'media-song.lua'); loads = loads + 1
      if broken then error('missing file') end
      return (function() ${songSource} end)()
    end
    ${installer}
    convaiMediaSongInstall()
    assert(loads == 0 and #observed == 0 and convaiMediaSong == nil, 'off: nothing loaded, nothing hooked')
    on = true
    convaiMediaSongInstall()
    assert(loads == 1 and #observed == 3 and type(convaiMediaSong) == 'table')
    convaiMediaSongInstall()
    assert(loads == 1 and #observed == 3, 'once')
    convaiMediaSong, broken = nil, true
    convaiMediaSongInstall()
    assert(convaiMediaSong == false and loads == 2)
    convaiMediaSongInstall()
    assert(loads == 2, 'not retried')
  `);
});
