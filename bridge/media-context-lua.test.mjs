// Music and TV, the game side (docs/DYNAMIC_INFO.md "Music and TV"): mod/media-context.lua with fake natives in fengari, the TV line ring of
// mod/game-dialogue.lua (and proof that it changes nothing the Recent game dialogue feature records), and the wiring in mod/init.lua and
// mod/turn-context.lua (the module is loaded only through the turn-context option, only while the kind is on, never per frame).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const source = read('../mod/media-context.lua');
const dialogueSource = read('../mod/game-dialogue.lua');
const turnContextSource = read('../mod/turn-context.lua');
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

// A world of fakes: every native counts its calls and can be made to raise.
const prelude = `
local M = (function() ${source} end)()
local calls, logs = {}, {}
local W = {vehicle = nil, carActive = true, carStation = 'st_growl', carTrack = 'tr_rebel', carIndex = 3,
  pocket = nil, pocketActive = false, pocketStation = nil, pocketTrack = nil, pocketIndex = 0,
  keyText = {st_growl = 'Growl FM', tr_rebel = 'Rebel Path'}, plainText = {}, stations = {[3] = 'st_growl'},
  lookAt = nil, query = nil, line = nil, failing = {}}
local N = {}
local function make(name, fn)
  N[name] = function(...)
    calls[name] = (calls[name] or 0) + 1
    if W.failing[name] then error('boom ' .. name) end
    return fn(...)
  end
end
make('vehicle', function() return W.vehicle end)
make('carActive', function() return W.carActive end)
make('carStation', function() return W.carStation end)
make('carTrack', function() return W.carTrack end)
make('carIndex', function() return W.carIndex end)
make('pocket', function() return W.pocket end)
make('pocketActive', function() return W.pocketActive end)
make('pocketStation', function() return W.pocketStation end)
make('pocketTrack', function() return W.pocketTrack end)
make('pocketIndex', function() return W.pocketIndex end)
make('stationName', function(index) return W.stations[index] end)
make('localizeKey', function(value) return W.keyText[value] end)
make('localizeText', function(text) return W.plainText[text] end)
make('tvLookAt', function() return W.lookAt end)
make('distance', function(_, entity) return entity.distance end)
make('tvQuery', function() return W.query end)
make('tvState', function(entity) return entity.state end)
make('tvChannelRecord', function(entity) return entity.record end)
make('tvLine', function(maxAge) if W.line and W.line.age <= maxAge then return W.line.text, W.line.age end end)
N.log = function(line) logs[#logs + 1] = line end
local reader = M.new({native = N})
local PLAYER = {}
local function tv(distance, state) return {distance = distance, state = state} end
local function on(key, index) return {on = true, key = key, index = index or 1} end
local function total() local n = 0; for _, c in pairs(calls) do n = n + c end; return n end
`;
const lua$ = body => run(prelude + '\n' + body);

test('a car radio that is playing: the station and the track, resolved by key, and no TV or pocket work at all', () => lua$(`
  W.vehicle = {}
  local result = reader:read(PLAYER)
  assert(result.radio.source == 'car' and result.radio.station == 'Growl FM' and result.radio.track == 'Rebel Path')
  assert(result.tv == nil)
  assert(calls.tvLookAt == nil and calls.tvQuery == nil and calls.tvState == nil and calls.pocket == nil, 'mounted: no TV, no pocket radio')
  assert(calls.carIndex == nil, 'the station index is only a fallback')
  assert(calls.carActive == 1 and calls.carStation == 1 and calls.carTrack == 1)
  assert(total() <= 8, 'a bounded handful of reads: ' .. total())
`));

test('a car radio that is off, or cannot say, reads as nothing and never looks for a TV from the car', () => lua$(`
  W.vehicle, W.carActive = {}, false
  assert(reader:read(PLAYER) == nil)
  assert(calls.carStation == nil and calls.carTrack == nil, 'inactive: the names are not read')
  assert(calls.tvLookAt == nil and calls.tvQuery == nil and calls.pocket == nil)
  assert(logs[#logs]:find('radio=car:inactive', 1, true))
  W.carActive = nil
  assert(reader:read(PLAYER) == nil)
  assert(logs[#logs]:find('radio=car:unknown', 1, true))
  W.carActive, W.failing.carActive = true, true
  assert(reader:read(PLAYER) == nil)
  assert(logs[#logs]:find('radio=car:unknown', 1, true))
`));

test('the resolvers: by key first, then by text, then the name itself when it has spaces; an unresolved key is never passed on', () => lua$(`
  W.vehicle = {}
  -- the key resolver answers the raw key back (not a translation): the text resolver is the second try
  W.keyText = {st_growl = 'st_growl', tr_rebel = ''}
  W.plainText = {st_growl = 'Growl FM', tr_rebel = 'Rebel Path'}
  local result = reader:read(PLAYER)
  assert(result.radio.station == 'Growl FM' and result.radio.track == 'Rebel Path')
  assert(logs[#logs]:find('station=[st_growl]->[Growl FM](Text)', 1, true) and logs[#logs]:find('track=[tr_rebel]->[Rebel Path](Text)', 1, true))
  -- a LocKey left in the answer is rejected
  W.keyText, W.plainText = {st_growl = 'LocKey#5', tr_rebel = 'LocKey#6'}, {}
  assert(reader:read(PLAYER) == nil, 'nothing readable: no radio, not a key')
  assert(logs[#logs]:find('radio=car:unresolved', 1, true) and logs[#logs]:find('(unresolved)', 1, true))
  -- a name that is already text (a mod's own station) is used as it is
  W.carStation, W.carTrack = 'My Own Station', 'tr_rebel'
  W.keyText = {}
  result = reader:read(PLAYER)
  assert(result.radio.station == 'My Own Station' and result.radio.track == nil)
  assert(logs[#logs]:find('(raw)', 1, true))
  -- the station falls back to the index when the receiver gives no name, and the track alone still counts
  W.carStation, W.carTrack, W.keyText = nil, 'tr_rebel', {st_growl = 'Growl FM', tr_rebel = 'Rebel Path'}
  result = reader:read(PLAYER)
  assert(result.radio.station == 'Growl FM' and result.radio.track == 'Rebel Path')
  assert(logs[#logs]:find('(index/ByKey)', 1, true))
  W.carIndex, calls.stationName = 0, nil
  result = reader:read(PLAYER)
  assert(result.radio.station == nil and result.radio.track == 'Rebel Path' and calls.stationName == nil, 'index 0 is no station')
`));

test('a name that has markup or control characters is cleaned, and a long one is cut', () => lua$(`
  W.vehicle = {}
  W.keyText = {st_growl = '<b>Growl</b>\\n FM', tr_rebel = string.rep('A', 400)}
  local result = reader:read(PLAYER)
  assert(result.radio.station == 'Growl FM')
  assert(#result.radio.track <= 120 and result.radio.track:sub(-3) == '...')
`));

test('one failing native costs that field, not the read: the track survives a station that raises, and nothing raises out', () => lua$(`
  W.vehicle, W.failing.carStation, W.failing.stationName = {}, true, true
  local result = reader:read(PLAYER)
  assert(result.radio.track == 'Rebel Path' and result.radio.station == nil)
  W.failing.carTrack = true
  assert(reader:read(PLAYER) == nil)
  W.failing.vehicle = true
  W.failing.pocket, W.failing.tvLookAt, W.failing.tvQuery = true, true, true
  assert(reader:read(PLAYER) == nil, 'the mount read raised: treated as on foot, and the rest raised too')
  assert(reader:read(nil) == nil)
  local broken = M.new({native = {}})
  assert(broken:read(PLAYER) == nil, 'an adapter with no natives at all')
  local rude = M.new({native = N, log = function() error('log failed') end})
  W.failing = {}
  assert(rude:read(PLAYER) ~= nil, 'a log that raises does not change the answer')
`));

test('nil from every native reads as nothing, and the one line says so', () => lua$(`
  local empty = {}
  for _, name in ipairs({'vehicle', 'carActive', 'carStation', 'carTrack', 'carIndex', 'pocket', 'pocketActive', 'tvLookAt', 'tvQuery', 'tvLine'}) do
    make(name, function() return nil end)
  end
  local reader2 = M.new({native = N})
  assert(reader2:read(PLAYER) == nil)
  assert(#logs == 1 and logs[1]:find('radio=pocket:none', 1, true) and logs[1]:find('tv=none(query failed)', 1, true), logs[1])
`));

test('the pocket radio is read on foot only: the station and track, or nothing when it is off', () => lua$(`
  W.pocket, W.pocketActive, W.pocketStation, W.pocketTrack = {}, true, 'st_growl', 'tr_rebel'
  local result = reader:read(PLAYER)
  assert(result.radio.source == 'pocket' and result.radio.station == 'Growl FM' and result.radio.track == 'Rebel Path')
  assert(calls.carActive == nil, 'on foot: the car receiver is never asked')
  W.pocketActive = false
  assert(reader:read(PLAYER) == nil)
  assert(logs[#logs]:find('radio=pocket:inactive', 1, true))
  W.pocketActive, W.pocketStation, W.pocketIndex = true, nil, 3
  result = reader:read(PLAYER)
  assert(result.radio.station == 'Growl FM', 'the pocket station falls back to its index')
  -- in a car the pocket radio is not read, even when it is "active"
  W.vehicle, W.carActive = {}, false
  calls.pocketActive = nil
  assert(reader:read(PLAYER) == nil and calls.pocketActive == nil)
`));

test('a TV: the one V looks at, if it is on and near; else the nearest that is on from one query; channel by key, record as the fallback', () => lua$(`
  W.lookAt = tv(4, on('ch_news'))
  W.keyText.ch_news = 'Channel 5 News'
  local result = reader:read(PLAYER)
  assert(result.tv.channel == 'Channel 5 News' and result.radio == nil and result.tv.said == nil)
  assert(calls.tvQuery == nil, 'the look-at TV is on: no query')
  assert(logs[#logs]:find('tv=lookat', 1, true) and logs[#logs]:find('channel=[ch_news]->[Channel 5 News](ByKey)', 1, true) and logs[#logs]:find('distance=4.0', 1, true))
  -- off, or too far: the query decides
  W.lookAt = tv(4, {on = false})
  W.query = {tv(9, on('ch_news')), tv(6, {on = false}), tv(3, on('ch_sports'))}
  W.keyText.ch_sports = 'Sports 24'
  result = reader:read(PLAYER)
  assert(result.tv.channel == 'Sports 24' and calls.tvQuery == 1, 'the nearest TV that is on')
  assert(logs[#logs]:find('tv=query', 1, true))
  W.lookAt = tv(40, on('ch_news'))
  W.query = {}
  assert(reader:read(PLAYER) == nil, 'a TV beyond ' .. M.TV_RADIUS .. ' m does not count')
  assert(logs[#logs]:find('tv=none(query found 0 TVs)', 1, true))
  W.query = {tv(M.TV_RADIUS + 0.5, on('ch_news')), tv(M.TV_RADIUS - 0.5, on('ch_sports'))}
  assert(reader:read(PLAYER).tv.channel == 'Sports 24', 'the radius is ' .. M.TV_RADIUS .. ' m')
  -- the channel key does not resolve: the TweakDB record name is the second try; neither: a TV that is on, with no channel
  W.lookAt, W.query = nil, {{distance = 5, state = on('ch_unknown', 2), record = 'ch_news'}}
  assert(reader:read(PLAYER).tv.channel == 'Channel 5 News')
  assert(logs[#logs]:find('(record/ByKey)', 1, true))
  W.query = {{distance = 5, state = on('ch_unknown', 2)}}
  local bare = reader:read(PLAYER)
  assert(bare.tv ~= nil and bare.tv.channel == nil and bare.tv.said == nil)
`));

test('the lookups are bounded: one look-at, at most one query, at most six TVs asked, nothing when the radio already filled the car', () => lua$(`
  W.lookAt = tv(2, {on = false})
  W.query = {}
  for index = 1, 20 do W.query[index] = tv(index * 0.5, {on = false}) end
  assert(reader:read(PLAYER) == nil)
  assert(calls.tvLookAt == 1 and calls.tvQuery == 1)
  assert(calls.tvState <= 1 + M.TV_CANDIDATES, 'asked ' .. tostring(calls.tvState))
  assert(calls.distance <= 1 + #W.query)
  -- the query itself is told the radius and a part limit
  local seen
  N.tvQuery = function(player, radius, limit) seen = {radius, limit}; return {} end
  reader:read(PLAYER)
  assert(seen[1] == M.TV_RADIUS and seen[2] == M.QUERY_PARTS)
  -- a TV is not looked for from a car, even with a TV in front of the car
  W.vehicle = {}
  calls = {}
  W.lookAt = tv(3, on('ch_news'))
  reader:read(PLAYER)
  assert(calls.tvLookAt == nil and calls.tvQuery == nil)
`));

test('what the TV just said joins the TV, and a line heard with no TV found counts only while it is fresh', () => lua$(`
  W.lookAt = tv(4, on('ch_news'))
  W.keyText.ch_news = 'Channel 5 News'
  W.line = {text = 'The mayor says the roads are safe.', age = 12}
  local result = reader:read(PLAYER)
  assert(result.tv.channel == 'Channel 5 News' and result.tv.said == 'The mayor says the roads are safe.')
  assert(logs[#logs]:find('said=yes', 1, true))
  W.line.age = 80
  assert(reader:read(PLAYER).tv.said == 'The mayor says the roads are safe.', 'up to ' .. M.SAID_AGE .. ' s with a TV in view')
  W.line.age = 100
  assert(reader:read(PLAYER).tv.said == nil)
  -- no TV located: a line heard a moment ago stands for the TV; an older one does not
  W.lookAt, W.query = nil, {}
  W.line = {text = 'Breaking news tonight.', age = 5}
  result = reader:read(PLAYER)
  assert(result.tv.said == 'Breaking news tonight.' and result.tv.channel == nil)
  assert(logs[#logs]:find('tv=heard', 1, true))
  W.line.age = M.HEARD_AGE + 5
  assert(reader:read(PLAYER) == nil)
  -- never from a car
  W.line.age, W.vehicle, W.carActive = 1, {}, false
  assert(reader:read(PLAYER) == nil)
`));

test('the radio and a TV can both be reported: a pocket radio and a TV in the room', () => lua$(`
  W.pocket, W.pocketActive, W.pocketStation, W.pocketTrack = {}, true, 'st_growl', 'tr_rebel'
  W.lookAt = tv(3, on('ch_news'))
  W.keyText.ch_news = 'Channel 5 News'
  local result = reader:read(PLAYER)
  assert(result.radio.source == 'pocket' and result.tv.channel == 'Channel 5 News')
`));

test('one probe.log line per distinct reading, with the raw key, the text and the resolver; never one per read', () => lua$(`
  W.vehicle = {}
  for _ = 1, 5 do reader:read(PLAYER) end
  assert(#logs == 1, #logs)
  assert(logs[1]:find('^Media: radio=car station=%[st_growl%]%->%[Growl FM%]%(ByKey%) track=%[tr_rebel%]%->%[Rebel Path%]%(ByKey%)'), logs[1])
  W.carTrack, W.keyText.tr_next = 'tr_next', 'Next Song'
  reader:read(PLAYER); reader:read(PLAYER)
  assert(#logs == 2 and logs[2]:find('[Next Song]', 1, true))
  W.carActive = false
  reader:read(PLAYER); reader:read(PLAYER)
  assert(#logs == 3 and logs[3]:find('radio=car:inactive', 1, true))
  -- the same song after another one is a change again, a repeat of the very same state is not
  W.carActive = true; W.carTrack = 'tr_rebel'
  reader:read(PLAYER)
  assert(#logs == 4)
  -- a name that varies cannot grow the log without end
  local limited = M.new({native = N, log = function(line) logs[#logs + 1] = line end})
  logs = {}
  for index = 1, M.MAX_LOGS + 50 do W.carTrack = 'k' .. index; W.keyText[W.carTrack] = 'Song ' .. index; limited:read(PLAYER) end
  assert(#logs == M.MAX_LOGS, #logs)
  -- no line carries control characters
  W.keyText.tr_odd = 'Odd\\nTitle'
  W.carTrack = 'tr_odd'
  local seen = {}
  local plain = M.new({native = N, log = function(line) seen[#seen + 1] = line end})
  plain:read(PLAYER)
  assert(#seen == 1 and not seen[1]:find('%c'), 'a title with a newline is one clean line')
`));

test('CName values: the text of a game CName is read through the game, not tostring', () => run(`
  Game = {NameToString = function(value) return value.text end}
  CName = {new = function(text) return {text = text} end}
  local M = (function() ${source} end)()
  local station, track = {text = 'st_growl'}, {text = 'tr_rebel'}
  local N = {vehicle = function() return {} end, carActive = function() return true end,
    carStation = function() return station end, carTrack = function() return track end,
    localizeKey = function(value) return ({st_growl = 'Growl FM', tr_rebel = 'Rebel Path'})[value.text] end}
  local result = M.new({native = N, log = function() end}):read({})
  assert(result.radio.station == 'Growl FM' and result.radio.track == 'Rebel Path')
  assert(M.nameText({text = 'x'}) == 'x')
`));

test('the default adapter asks the game for exactly the things the research found, each behind a guard', () => {
  for (const call of ['GetMountedVehicle', 'IsRadioReceiverActive', 'GetRadioReceiverStationName', 'GetRadioReceiverTrackName', 'GetCurrentRadioIndex',
    'GetPocketRadio', 'GetStationName', 'GetTrackName', 'GetLocalizedTextByKey', 'GetLocalizedText', 'GetLookAtObject', 'GetTargetParts', 'GetActiveStationIndex',
    'GetChannelName', 'GetRadioStationLocalizedName']) assert.ok(source.includes(call), call);
  // No hook, observer, timer, file or write of any kind; nothing runs per frame; every game call lives in the adapter or behind pcall.
  assert.doesNotMatch(source, /registerForEvent|Observe\(|ObserveAfter\(|ObserveBefore\(|Override\(|onUpdate|io\.open|os\.remove|:Set[A-Z]|:Apply|:Play|:Spawn|CreateEntity|DeleteEntity/);
  // An unknown device is never turned on or initialised: GetActiveStationIndex is read only after IsON.
  assert.ok(source.indexOf('ps:IsON()') < source.indexOf('ps:GetActiveStationIndex()'));
});

test('the default adapter TV query: no part limit of 40 that NPC parts can fill, secondary targets, a TV by class or by controller, and what it saw', () => run(`
  local M = (function() ${source} end)()
  local asked = {}
  local function entity(id, class, ps)
    return {id = id, class = class, ps = ps,
      IsA = function(self, name) return name == self.class end,
      GetEntityID = function(self) return {hash = self.id} end,
      GetClassName = function(self) return self.class end,
      GetDevicePS = function(self) if self.ps == false then error('not a device') end return self.ps end}
  end
  local function part(e) return {GetComponent = function() return {GetEntity = function() return e end} end} end
  -- Judy and Alex bring 60 parts before the room's devices do; the TV is the 71st part
  local parts = {}
  for i = 1, 30 do parts[#parts + 1] = part(entity(100, 'NPCPuppet', false)) end
  for i = 1, 30 do parts[#parts + 1] = part(entity(101, 'NPCPuppet', false)) end
  parts[#parts + 1] = part(entity(1, 'Door', {IsA = function() return false end}))
  parts[#parts + 1] = part(entity(1, 'Door', {IsA = function() return false end}))
  local tvEntity = entity(2, 'TV', {})
  parts[#parts + 1] = part(tvEntity)
  local odd = entity(3, 'Screen', {IsA = function(_, name) return name == 'TVControllerPS' end})
  parts[#parts + 1] = part(odd)
  TargetSearchQuery = {new = function() return {} end}
  Enum = {new = function(name, value) return name .. '.' .. value end}
  Game = {NameToString = function(value) return value end,
    GetTargetingSystem = function() return {GetTargetParts = function(_, player, query) asked = query; return true, parts end} end}
  local N = M.adapter()
  local list, stats = N.tvQuery({}, 12, M.QUERY_PARTS)
  assert(#list == 2 and list[1] == tvEntity and list[2] == odd, 'the TV by its class and the one by its controller, each once')
  assert(asked.includeSecondaryTargets == true and asked.testedSet == 'TargetingSet.Complete' and asked.maxDistance == 12)
  assert(stats.parts == 64 and stats.objects == 5 and stats.classes == 'NPCPuppet:2,Door:1', stats.classes)
  assert(M.QUERY_PARTS >= 200, 'more than the 40 parts the first version looked at')
  -- a limit cuts the list and says so; a part that raises costs that part only
  local limited, cut = N.tvQuery({}, 12, 62)
  assert(#limited == 0 and cut.cut == true and cut.parts == 62)
  parts[1] = {GetComponent = function() error('boom') end}
  assert(#N.tvQuery({}, 12, 100) == 2)
  Game.GetTargetingSystem = function() return {GetTargetParts = function() return true, nil end} end
  local none, empty = N.tvQuery({}, 12, 100)
  assert(#none == 0 and empty.parts == 0 and empty.classes == '')
`));

test('probe.log says why no TV was found: how many parts and objects the query saw, which classes, and what turned TVs away', () => lua$(`
  W.lookAt = nil
  N.tvQuery = function() return {}, {parts = 37, objects = 12, classes = 'Door:3,Light:2'} end
  assert(reader:read(PLAYER) == nil)
  assert(logs[#logs]:find('tv=none(query found 0 TVs) said=no why: parts=37 objects=12 seen=Door:3,Light:2', 1, true), logs[#logs])
  -- TVs found but none on, one beyond the radius, and the look-at TV off
  W.lookAt = tv(3, {on = false})
  N.tvQuery = function() return {tv(5, {on = false}), tv(M.TV_RADIUS + 3, on('ch_news'))}, {parts = 400, cut = true, objects = 20, classes = ''} end
  assert(reader:read(PLAYER) == nil)
  local line = logs[#logs]
  assert(line:find('query found 2 TVs', 1, true) and line:find('parts=400+', 1, true) and line:find('beyondRadius=1', 1, true)
    and line:find('notOn=1', 1, true) and line:find('lookedAtTvNotOn', 1, true), line)
  -- the reason is not part of the dedupe key: a new part count on the same outcome adds no line
  local count = #logs
  N.tvQuery = function() return {tv(5, {on = false}), tv(M.TV_RADIUS + 3, on('ch_news'))}, {parts = 399, cut = true, objects = 21, classes = ''} end
  reader:read(PLAYER)
  assert(#logs == count)
`));

// ---- the TV line ring of mod/game-dialogue.lua --------------------------------------------------------------------------------------------------
const dialoguePrelude = `
local api = (function() ${dialogueSource} end)()
local now, wanted, enabled = 1000, true, true
local player = {id = '99ULL'}
local N = {player = function() return player end, ready = function(p) return p ~= nil end, entity = function(o) return o.id end,
  braindance = function() return false end, replacer = function() return false end, playerCombat = function() return false end,
  npcCombat = function() return false end, isVehicle = function(o) return o.vehicle == true end, call = function() return nil end,
  lineType = function(value) return value end, text = function(line) return line.text end,
  speakerName = function(line) return line.speakerName end, lineId = function(line) return tostring(line.id) end,
  lineNumber = function(line) return tonumber(line.id) end, fromVariant = function(value) return value end,
  dialogChoice = function() return false end, activeHub = function() return 0 end, localized = function(text) return text end,
  subtitles = function() return {serial = 0} end}
local present = {}
local dialogue = api.new({native = N, now = function() return now end, enabled = function() return enabled end,
  heardWanted = function() return wanted end,
  resolve = function(speaker) if speaker.key then return speaker.key, speaker.name end end,
  resolveName = function() return nil end, contactKey = function() return nil end, present = function() return present end})
local nextId = 100
local function say(kind, text, speaker, hook)
  nextId = nextId + 1
  local line = {id = nextId, type = kind, speaker = speaker, text = text}
  return dialogue:line(line, hook or 'show'), line
end
local JUDY = {id = '11ULL', key = 'judy-alvarez', name = 'Judy'}
`;
const dialogue$ = body => run(dialoguePrelude + '\n' + body);

test('TV lines are kept in a tiny ring: GlobalTV and GlobalTVAlwaysVisible only, newest last, at most three, text capped', () => dialogue$(`
  say('GlobalTV', 'The weather is mild tonight.')
  now = now + 4
  say('GlobalTVAlwaysVisible', 'Stay tuned for the news.')
  now = now + 4
  say('Regular', 'This is no TV line.', JUDY)
  say('Radio', 'You are listening to Radio Pebkac.', {id = 'veh', vehicle = true})
  say('OverHead', 'Chatter.', JUDY)
  assert(#dialogue.heard == 2)
  local text, age = dialogue:heardMedia(60)
  assert(text == 'Stay tuned for the news.' and age == 4)
  now = now + 3; say('GlobalTV', 'Third.')
  now = now + 3; say('GlobalTV', 'Fourth.')
  assert(#dialogue.heard == api.HEARD_KEEP and api.HEARD_KEEP == 3)
  assert(dialogue.heard[1].text == 'Stay tuned for the news.' and dialogue.heard[3].text == 'Fourth.')
  say('GlobalTV', string.rep('long ', 100))
  assert(#dialogue.heard[3].text <= api.HEARD_TEXT)
`));

test('the ring answers by age, and a line that is too old is not heard', () => dialogue$(`
  assert(dialogue:heardMedia(60) == nil)
  say('GlobalTV', 'Hello there.')
  now = now + 30
  assert(dialogue:heardMedia(60) == 'Hello there.')
  assert(dialogue:heardMedia(20) == nil)
  now = now + 100
  assert(dialogue:heardMedia(60) == nil and dialogue:heardMedia() == nil)
`));

test('the two subtitle hooks show one line once; the same words a moment later are one line', () => dialogue$(`
  local _, line = say('GlobalTV', 'One line.')
  dialogue:line(line, 'event')
  assert(#dialogue.heard == 1)
  now = now + 2
  say('GlobalTV', 'One line.')
  assert(#dialogue.heard == 1, 'a repeat within the duplicate window')
  now = now + 30
  say('GlobalTV', 'One line.')
  assert(#dialogue.heard == 2)
`));

test('nothing is kept while the Music and TV switch is off, and a missing option costs nothing', () => dialogue$(`
  wanted = false
  say('GlobalTV', 'Not kept.')
  assert(#dialogue.heard == 0)
  wanted = true
  local bare = api.new({native = N, now = function() return now end})
  nextId = nextId + 1
  bare:line({id = nextId, type = 'GlobalTV', text = 'Not kept either.'}, 'show')
  assert(#bare.heard == 0, 'without options.heardWanted nothing is kept')
`));

test('Recent game dialogue is exactly as before: TV lines are still skipped as a type, never recorded, never sent', () => dialogue$(`
  present = {'judy-alvarez'}
  local before = {say('Regular', 'Meet me at the Afterlife.', JUDY)}
  say('GlobalTV', 'TV words.')
  say('GlobalTVAlwaysVisible', 'More TV words.')
  local snapshot = dialogue:capture()
  assert(#snapshot.lines == 1 and snapshot.lines[1].text == 'Meet me at the Afterlife.')
  local status = dialogue:status()
  assert(status.skipped.type == 2 and status.recorded == 1, 'both TV lines are skipped as a type, as ever')
  assert(status.types.GlobalTV == 1 and status.types.GlobalTVAlwaysVisible == 1)
  assert(#dialogue.heard == 2)
  -- with the Music and TV switch off the recorder behaves identically
  wanted = false
  say('GlobalTV', 'Again.')
  assert(dialogue:status().skipped.type == 3 and #dialogue:capture().lines == 1)
  -- the car radio's DJ is not game dialogue and not a TV line
  wanted = true
  say('Radio', 'DJ talk.', {id = 'veh', vehicle = true})
  assert(dialogue:status().skipped.radio == 1 and #dialogue.heard == 2)
`));

test('the ring survives the dialogue context being off (it is a Music and TV matter), and a reset for another reason clears it', () => dialogue$(`
  enabled = false
  say('GlobalTV', 'Heard while the context is off.')
  assert(dialogue:heardMedia(60) == 'Heard while the context is off.')
  assert(dialogue:capture() == nil, 'the context is off: nothing captured')
  assert(dialogue:heardMedia(60) == 'Heard while the context is off.', 'capture() resets with "disabled": the ring stays')
  dialogue:reset('world-change')
  assert(dialogue:heardMedia(60) == nil)
`));

test('the add-on and Johnny paths are untouched: no TV line reaches onRow or onGameLine', () => dialogue$(`
  local rows, voices = {}, {}
  local second = api.new({native = N, now = function() return now end, heardWanted = function() return true end,
    onRow = function(row) rows[#rows + 1] = row end, onGameLineWanted = function() return true end,
    onGameLine = function(seconds, kind) voices[#voices + 1] = kind end})
  nextId = nextId + 1
  second:line({id = nextId, type = 'GlobalTV', text = 'TV talk.'}, 'show')
  assert(#rows == 0 and #voices == 0 and #second.heard == 1)
`));

test('the subtitle hook is the existing one: no new Observe, and the game-dialogue install still names its four hooks', () => {
  const observes = dialogueSource.match(/observe\('/g) ?? [];
  assert.equal(observes.length, 4, 'the same four hooks as before');
  assert.match(dialogueSource, /pcall\(self\.noteHeard, self, line\)/);
  assert.match(init, /heardWanted = function\(\) return manager\.dynamicInfo == nil or manager\.dynamicInfo\('media'\) end/);
});

// ---- the wiring ------------------------------------------------------------------------------------------------------------------------------
const between = (from, to, text = init) => {
  const start = text.indexOf(from), end = text.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `markers ${from} .. ${to}`);
  return text.slice(start, end);
};

test('loader: the module is loaded lazily, once, only through the turn-context option; a broken module is not retried', () => {
  const loader = between('media = function(player)', 'mods = function(player)');
  run(`
    local loads, broken, reads = 0, false, 0
    local real = {read = function(player) reads = reads + 1; return {radio = {source = 'car', track = 'x'}} end}
    function dofile(path)
      assert(path == 'media-context.lua'); loads = loads + 1
      if broken then error('missing file') end
      return real
    end
    local options = {
      ${loader}
      mods = function() end}
    assert(loads == 0, 'nothing is loaded when the table is built')
    assert(options.media({}).radio.track == 'x' and loads == 1 and reads == 1)
    options.media({}); assert(loads == 1 and reads == 2, 'loaded once')
    convaiMediaContext, broken = nil, true
    assert(options.media({}) == nil and loads == 2)
    assert(options.media({}) == nil and loads == 2, 'a failed load is not retried every turn')
  `);
  assert.equal((init.match(/dofile, 'media-context\.lua'/g) ?? []).length, 1, 'one loader in init.lua');
});

test('turn-context: the media reader is called only while the Music and TV switch is on, at most once per snapshot, and its table joins the snapshot', () => {
  run(`
    local M = (function() ${turnContextSource} end)()
    local reads = 0
    local N = {player = function() return {} end, ready = function() return true end, clock = function() return 12, 30, 'native' end}
    local on = true
    local reader = M.new({native = N, now = function() return 100 end, enabled = function(kind) if kind == 'media' then return on end return true end,
      media = function(player) reads = reads + 1; return {radio = {source = 'car', track = 'x'}} end})
    local snapshot = reader:capture()
    assert(snapshot.media and snapshot.media.radio.track == 'x' and reads == 1)
    reader:capture(); assert(reads == 1, 'the 5 s snapshot is reused: one read')
    on = false
    snapshot = reader:capture()
    assert(snapshot.media == nil and reads == 1, 'switched off: not read, not in the snapshot')
    local plain = M.new({native = N, now = function() return 100 end, enabled = function() return true end,
      media = function() return {} end})
    assert(plain:capture().media == nil, 'an empty table is no media')
    local bad = M.new({native = N, now = function() return 100 end, enabled = function() return true end,
      media = function() error('boom') end})
    assert(bad:capture().hour == 12, 'a reader that raises does not break the turn')
  `);
});

test('cost: nothing of it runs per frame', () => {
  const update = init.slice(init.indexOf("registerForEvent('onUpdate'"), init.indexOf("registerForEvent('onShutdown'"));
  assert.doesNotMatch(update, /convaiMediaContext|media-context|heardMedia/, 'onUpdate is untouched');
});

test('a receiver whose own track name is empty falls back to the station\'s current track by index, and probe.log says why the first read gave nothing', () => lua$(`
  W.vehicle, W.carTrack = {}, nil
  make('trackByIndex', function(index) return index == 3 and 'tr_rebel' or nil end)
  local result = reader:read(PLAYER)
  assert(result.radio.station == 'Growl FM' and result.radio.track == 'Rebel Path', tostring(result.radio.track))
  assert(calls.trackByIndex == 1 and calls.carIndex == 1)
  assert(logs[#logs]:find('index/ByKey', 1, true), logs[#logs])
  -- both reads give nothing: the station alone is sent, and the log line carries the reason
  W.carTrack = 'None'
  make('trackByIndex', function() return nil end)
  local again = M.new({native = N})
  W.failing.carTrack = true
  local result2 = again:read(PLAYER)
  assert(result2.radio.station == 'Growl FM' and result2.radio.track == nil)
  assert(logs[#logs]:find('trackWhy=error:', 1, true), logs[#logs])
`));
