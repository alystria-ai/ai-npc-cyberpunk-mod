local convaiPlayer = convaiPlayer or function() return Game.GetPlayer() end
-- Developer probe for Music and TV (docs/DYNAMIC_INFO.md "Music and TV", mod/media-context.lua): the live evidence the offline tests cannot give. In ONE run it
-- dumps the raw value of every candidate read, so the real shapes are known after one session: the car receiver (active, station and track CNames, both
-- localisation resolvers), the station records and the station names by index, the pocket radio, the TV V looks at, every object a targeting query
-- returns near V (class name and distance, so a TV under another class name shows), each TV's power, channel and channel data, the TV line ring, and
-- the production read itself with the probe.log line it would write. Each section is timed.
--
-- Run from mod/johnny-probe.lua (the developer mailbox, Developer mode only) as "johnny-probe:media:read:<stamp>" through scripts/Send-JohnnyProbe.ps1
-- (`media read`); the report is runtime/johnny-probe.json. Never loaded for a player, adds no hook, timer or write of its own, and every read is guarded: a
-- section that raises reports its error text and the rest still run. Actions: read (everything), car, pocket, stations, tv, ring, production.
-- To compare against the HUD: get in a car with the radio on (read), turn the radio to another station (read), get out with the pocket radio on (read),
-- stand near a TV that is on and look at it (read), then look away from it (read).
local M = {}
local MAX_ROWS, MAX_TEXT = 60, 300
M.ACTIONS = {read = true, car = true, pocket = true, stations = true, tv = true, ring = true, production = true}

local media = nil
local function nameText(value)
    if media then return media.nameText(value) end
    return tostring(value)
end

-- A value as something JSON can carry: numbers and booleans as they are, a CName or any other object as its text, nil as a marker, long text cut.
local function shown(value)
    local kind = type(value)
    if value == nil then return '<nil>' end
    if kind == 'boolean' or kind == 'number' then return value end
    if kind == 'string' then return value:gsub('%c', ' '):sub(1, MAX_TEXT) end
    local text = nameText(value)
    return type(text) == 'string' and text:gsub('%c', ' '):sub(1, MAX_TEXT) or '<' .. kind .. '>'
end
-- Run one read: its value as `shown`, or 'ERROR: ...'.
local function val(fn, ...)
    local ok, value = pcall(fn, ...)
    if ok then return shown(value) end
    return 'ERROR: ' .. tostring(value):gsub('%s+', ' '):sub(1, 160)
end
-- A localisation key both ways: what the game's now-playing toast does (the CName through GetLocalizedTextByKey) and the string form.
local function locs(key)
    if key == nil then return {raw = '<nil>'} end
    local raw = shown(key)
    return {raw = raw,
        byKey = val(function() return Game.GetLocalizedTextByKey(type(key) == 'string' and CName.new(key) or key) end),
        byText = val(function() return Game.GetLocalizedText(tostring(raw)) end)}
end
local function distance(player, entity)
    local a, b = player:GetWorldPosition(), entity:GetWorldPosition()
    return math.floor(math.sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2 + (a.z - b.z) ^ 2) * 10 + 0.5) / 10
end
local function class(object) return val(function() return nameText(object:GetClassName()) end) end

local function car(player)
    local vehicle = player:GetMountedVehicle()
    if vehicle == nil then return {mounted = false} end
    local report = {mounted = true, class = class(vehicle),
        active = val(function() return vehicle:IsRadioReceiverActive() end),
        wasPlaying = val(function() return vehicle:WasRadioReceiverPlaying() end),
        index = val(function() return vehicle:GetCurrentRadioIndex() end)}
    local ok, stationKey = pcall(function() return vehicle:GetRadioReceiverStationName() end)
    local okTrack, trackKey = pcall(function() return vehicle:GetRadioReceiverTrackName() end)
    report.station = ok and locs(stationKey) or {error = tostring(stationKey):sub(1, 160)}
    report.track = okTrack and locs(trackKey) or {error = tostring(trackKey):sub(1, 160)}
    local index = tonumber(report.index)
    if index then report.stationByIndex = val(function() return locs(Game.GetRadioStationLocalizedName(index)).byKey end) end
    -- The station's own current track by the station name CName (the global GetRadioStationCurrentTrackName takes a station id).
    if ok and stationKey ~= nil then
        report.currentTrackOfStation = val(function() return locs(Game.GetRadioStationCurrentTrackName(stationKey)).byKey end)
    end
    -- The vehicle blackboard (set only on radio events, so it can be stale).
    report.blackboard = {
        state = val(function() local defs = Game.GetAllBlackboardDefs(); return vehicle:GetBlackboard():GetBool(defs.Vehicle.VehRadioState) end),
        stationName = val(function() local defs = Game.GetAllBlackboardDefs(); return vehicle:GetBlackboard():GetName(defs.Vehicle.VehRadioStationName) end)}
    return report
end

local STATION_RECORDS = {'NoStation', 'Downtempo', 'AggroIndie', 'GrowlFM', 'Jazz', 'ElectroIndie', 'MinimTech', 'Metal', 'Pop', 'Impulse',
    'HipHop', 'AggroTechno', 'Latino', 'AttRock', 'DarkStar', 'HKGN'}
local function stations()
    local report = {records = {}, byIndex = {}}
    for _, name in ipairs(STATION_RECORDS) do
        report.records[#report.records + 1] = {record = name, read = val(function()
            local record = TweakDBInterface.GetRadioStationRecord(TweakDBID.new('RadioStation.' .. name))
            if record == nil then return 'no such record' end
            local row = {index = val(function() return record:Index() end), displayName = locs(val(function() return record:DisplayName() end))}
            row.enumName = val(function() return record:EnumName() end)
            return row.index .. ' | ' .. tostring(row.displayName.raw) .. ' | ' .. tostring(row.displayName.byKey) .. ' | ' .. tostring(row.displayName.byText) .. ' | ' .. tostring(row.enumName)
        end)}
    end
    for index = 0, 16 do
        report.byIndex[#report.byIndex + 1] = {index = index, name = val(function() return Game.GetRadioStationLocalizedName(index) end),
            text = val(function() return locs(Game.GetRadioStationLocalizedName(index)).byKey end)}
    end
    return report
end

local function pocket(player)
    local radio = player:GetPocketRadio()
    if radio == nil then return {radio = false} end
    local report = {radio = true, active = val(function() return radio:IsActive() end), station = val(function() return radio:GetStation() end)}
    local ok, stationKey = pcall(function() return radio:GetStationName() end)
    local okTrack, trackKey = pcall(function() return radio:GetTrackName() end)
    report.stationName = ok and locs(stationKey) or {error = tostring(stationKey):sub(1, 160)}
    report.trackName = okTrack and locs(trackKey) or {error = tostring(trackKey):sub(1, 160)}
    return report
end

local function tvDevice(player, entity)
    local row = {class = class(entity), distance = val(function() return distance(player, entity) end)}
    local ps = nil
    local ok, device = pcall(function() return entity:GetDevicePS() end)
    if not ok or device == nil then row.devicePS = ok and '<nil>' or ('ERROR: ' .. tostring(device):sub(1, 120)); return row end
    ps = device
    row.psClass = class(ps)
    row.isOn = val(function() return ps:IsON() end)
    row.isUnpowered = val(function() return ps:IsUnpowered() end)
    row.isDisabled = val(function() return ps:IsDisabled() end)
    -- The channels' names are a plain list read, safe whatever the state; the active station index is read only for a TV that is on (it can initialise one that never was).
    row.channelNames = {}
    for index = 0, 5 do row.channelNames[#row.channelNames + 1] = {index = index, name = val(function() return locs(ps:GetChannelName(index)).raw end),
        text = val(function() return locs(ps:GetChannelName(index)).byKey end), textB = val(function() return locs(ps:GetChannelName(index)).byText end)} end
    if row.isOn == true then
        row.activeIndex = val(function() return ps:GetActiveStationIndex() end)
        local index = tonumber(row.activeIndex)
        if index then
            row.activeName = val(function() local l = locs(ps:GetChannelName(index)); return l.raw .. ' | ' .. tostring(l.byKey) .. ' | ' .. tostring(l.byText) end)
            local ok2, data = pcall(function() return ps:GetChannelData(index) end)
            if ok2 and data ~= nil then
                row.channelData = {channelName = val(function() local l = locs(data.channelName); return l.raw .. ' | ' .. tostring(l.byKey) .. ' | ' .. tostring(l.byText) end),
                    videoPath = val(function() return data.videoPath end),
                    audioEvent = val(function() return data.audioEvent end), looped = val(function() return data.looped end),
                    channelTweakID = val(function() return TDBID.ToStringDEBUG(data.channelTweakID) end),
                    recordName = val(function() local record = TweakDBInterface.GetChannelDataRecord(data.channelTweakID); local l = locs(record:LocalizedName()); return l.raw .. ' | ' .. tostring(l.byKey) .. ' | ' .. tostring(l.byText) end)}
            else
                row.channelData = ok2 and '<nil>' or ('ERROR: ' .. tostring(data):sub(1, 120))
            end
        end
    end
    return row
end

local function tv(player)
    local report = {radius = media and media.TV_RADIUS or 12}
    local ok, object = pcall(function() return Game.GetTargetingSystem():GetLookAtObject(player, false, false) end)
    if not ok then report.lookAt = 'ERROR: ' .. tostring(object):sub(1, 160)
    elseif object == nil then report.lookAt = '<nil>'
    else report.lookAt = {class = class(object), isTV = val(function() return object:IsA('TV') end), distance = val(function() return distance(player, object) end)} end
    -- Everything a query returns near V, with class names, so a TV that is not class TV (a wall screen, an LCD) shows up here.
    report.query = {parts = {}}
    local okQuery, parts = pcall(function()
        local query = TargetSearchQuery.new()
        query.testedSet = Enum.new('TargetingSet', 'Complete')
        query.maxDistance = report.radius + 8
        query.filterObjectByDistance = true
        query.ignoreInstigator = true
        local _, found = Game.GetTargetingSystem():GetTargetParts(player, query)
        return found
    end)
    if not okQuery then report.query.error = tostring(parts):sub(1, 160); return report end
    report.query.count = #(parts or {})
    local seen, tvs = {}, {}
    for index, part in ipairs(parts or {}) do
        if index > MAX_ROWS then break end
        local okEntity, entity = pcall(function() return part:GetComponent():GetEntity() end)
        if not okEntity or entity == nil then okEntity, entity = pcall(function() return TS_TargetPartInfo.GetComponent(part):GetEntity() end) end
        if okEntity and entity ~= nil then
            local id = val(function() return tostring(entity:GetEntityID().hash) end)
            if not seen[id] then
                seen[id] = true
                local isTv = val(function() return entity:IsA('TV') end)
                report.query.parts[#report.query.parts + 1] = {class = class(entity), isTV = isTv, distance = val(function() return distance(player, entity) end)}
                if isTv == true and #tvs < 5 then tvs[#tvs + 1] = entity end
            end
        else
            report.query.parts[#report.query.parts + 1] = {error = 'no entity'}
        end
    end
    report.devices = {}
    if type(report.lookAt) == 'table' and report.lookAt.isTV == true then
        report.devices[#report.devices + 1] = {from = 'lookAt', read = tvDevice(player, object)}
    end
    for _, entity in ipairs(tvs) do report.devices[#report.devices + 1] = {from = 'query', read = tvDevice(player, entity)} end
    return report
end

local function ring()
    local dialogue = convaiGameDialogue
    if type(dialogue) ~= 'table' then return {installed = false} end
    local report = {installed = type(dialogue.heardMedia) == 'function', lines = {}}
    local now = dialogue.now and dialogue:now() or os.time()
    for _, row in ipairs(dialogue.heard or {}) do report.lines[#report.lines + 1] = {age = now - row.at, text = shown(row.text)} end
    report.newest = val(function() return dialogue:heardMedia(600) end)
    report.types = val(function() return dialogue:status().types end)
    return report
end

-- The production read (two reads: the second shows that the same reading adds no log line), with the lines it logged.
local function production(player)
    if not media then return {error = 'media-context.lua is not loaded'} end
    local lines = {}
    local reader = media.new({native = media.adapter(), log = function(line) lines[#lines + 1] = line end})
    local started = os.clock()
    local first = reader:read(player)
    local firstMs = math.floor((os.clock() - started) * 10000 + 0.5) / 10
    started = os.clock()
    local second = reader:read(player)
    local secondMs = math.floor((os.clock() - started) * 10000 + 0.5) / 10
    local function plain(result)
        if type(result) ~= 'table' then return '<nil>' end
        local out = {}
        for part, row in pairs(result) do
            out[part] = {}
            for key, value in pairs(row) do out[part][key] = shown(value) end
        end
        return out
    end
    return {first = plain(first), second = plain(second), firstMs = firstMs, secondMs = secondMs, logged = lines}
end

function M.run(action, env)
    local name = tostring(action):match('^[%a]+') or 'read'
    if not M.ACTIONS[name] then error('unknown media probe action ' .. tostring(action) .. ' (read, car, pocket, stations, tv, ring, production)') end
    local loaded, module = pcall(dofile, 'media-context.lua')
    media = loaded and type(module) == 'table' and module or nil
    local player = env and env.player or convaiPlayer()
    local report = {action = name, loaded = media ~= nil, timingsMs = {}}
    local function section(key, fn)
        if name ~= 'read' and name ~= key then return end
        local started = os.clock()
        local ok, value = pcall(fn, player)
        report[key] = ok and value or {error = tostring(value):sub(1, 300)}
        report.timingsMs[key] = math.floor((os.clock() - started) * 10000 + 0.5) / 10
    end
    section('car', car); section('pocket', pocket); section('stations', stations); section('tv', tv); section('ring', ring); section('production', production)
    return report
end

return M
