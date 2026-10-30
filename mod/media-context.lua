-- Music and TV (Settings > Dynamic info > Music and TV, docs/DYNAMIC_INFO.md): the song playing on the car radio while V rides in a car, or on V's
-- pocket radio while V is on foot, and what a TV near V is showing. Read-only and on demand, in the style of mod/turn-context.lua: it is called
-- from that module's snapshot read (options.media, wired in init.lua, loaded the first time a turn is built with the switch on), so it runs at a
-- conversation turn at most once per 5 s snapshot and never per frame; it has no timer, hook, observer, file or cache of its own.
-- Every native call is guarded (a missing or changed game API drops that field, never the turn) and one turn reads at most a handful of natives:
--   in a vehicle   the car receiver: IsRadioReceiverActive, then the station and track names (and the station index only as a fallback)
--   on foot        the pocket radio (IsActive, then the same), then one look-at read, then the TV that last spoke by its ID (one
--                  FindEntityByID), and when those find no TV, one targeting query
-- Everything below is VERIFIED to exist in the game's script caches (2.5 and 2.31) but NOT yet to answer through CET, nor what the values look like:
-- the station and track are localisation keys (CNames) that the game's own now-playing toast runs through GetLocalizedTextByKey. So each one is
-- resolved with Game.GetLocalizedTextByKey and then Game.GetLocalizedText, a result that is empty, equal to the key or still a LocKey is rejected,
-- and ONE probe.log line per distinct (radio, station, track, TV channel) says what was read (the raw key, the text, which resolver worked) so a
-- live pass can set it against the HUD. mod/media-probe.lua dumps every candidate read in Developer mode.
-- A TV exposes only its channel, not the programme. The nearest words for what is on are the TV's own recent speech lines, which mod/game-dialogue.lua
-- keeps in a tiny ring (Instance:heardMedia) from the subtitle callback it already has.
-- The radio host (the DJ or presenter between songs) is told the same way: lines of type Radio that are a broadcast on the receiver that is on
-- (V's car radio, or the pocket radio on foot) go into a ring of their own (Instance:heardRadioLines, filtered by mod/game-dialogue.lua noteRadio so
-- the Delamain cab's voice, a quest voice, another car's radio and a call never count), and the last line or two, at most SAID_AGE seconds old,
-- become radio.said beside the radio that is on.
-- The result is a plain table the bridge validates (bridge/media-context.mjs):
--   {radio = {source = 'car' | 'pocket', station = <text>, track = <text>, said = <what the radio host just said>},
--    tv = {channel = <text>, said = <the last line a TV said>}}
local M = {}
M.TV_RADIUS, M.QUERY_PARTS, M.TV_CANDIDATES = 12, 400, 6   -- metres, targeting parts looked at, TVs asked whether they are on
M.TV_MEMORY = 1800                    -- seconds: a TV that spoke this long ago is still looked up by its ID (it must still be near and on)
M.SAID_AGE, M.HEARD_AGE = 90, 20      -- seconds: a TV line this young is "just said"; a TV line alone (no TV located) counts this long
M.MAX_TEXT, M.MAX_LOGS = 120, 200
M.MAX_RADIO_SAID = 200                -- characters: the host's last line or two (the same age rule as a TV in view: SAID_AGE)
-- A targeting query that found no TV that is on is not asked again for QUERY_REST seconds while V stays within QUERY_MOVE metres of where it
-- was asked: in a street the query lists every part within 12 m (up to QUERY_PARTS, about ten native reads each), and every turn on foot would
-- pay for it. A TV V looks at, or one that just spoke, is found before the query and never waits for it.
M.QUERY_REST, M.QUERY_MOVE = 20, 3

local function call(fn, ...)
    if type(fn) ~= 'function' then return nil end
    local ok, a, b, c = pcall(fn, ...)
    if ok then return a, b, c end
    return nil
end

-- A CName (or a string) as plain text. tostring() of a CName prints its text in a comment.
local function nameText(value)
    if type(value) == 'string' then return value end
    if value == nil then return nil end
    local ok, text = pcall(function() return Game.NameToString(value) end)
    if ok and type(text) == 'string' and text ~= '' and text ~= 'None' then return text end
    ok, text = pcall(tostring, value)
    if ok and type(text) == 'string' then return text:match('%-%-%[%[%s*(.-)%s*%-%-%]%]') or text end
    return nil
end
M.nameText = nameText

-- A CName's hash as hex, or nil (a string, a None name, or no hash to read). The song's CName is real but its text is not in CET's name pool,
-- so nameText gives '' for it (the live pass of 2026-10-25: trackWhy=none: with nothing after it); the game localises it by this hash.
local function nameHash(value)
    if value == nil or type(value) == 'string' then return nil end
    local ok, hi, lo = pcall(function() return value.hash_hi, value.hash_lo end)
    if not ok or type(hi) ~= 'number' or type(lo) ~= 'number' or (hi == 0 and lo == 0) then return nil end
    return string.format('%08x%08x', hi, lo)
end
M.nameHash = nameHash

local function clean(value, limit)
    if type(value) ~= 'string' then return nil end
    local text = value:gsub('<[^>]*>', ''):gsub('%c', ' '):gsub('%s+', ' '):match('^%s*(.-)%s*$')
    if text == '' or text:find('LocKey#', 1, true) then return nil end
    if #text > limit then
        -- Cut on a UTF-8 boundary, never inside a character.
        local cut = limit - 3
        while cut > 0 and text:byte(cut + 1) and text:byte(cut + 1) >= 0x80 and text:byte(cut + 1) < 0xC0 do cut = cut - 1 end
        text = text:sub(1, cut) .. '...'
    end
    return text
end

-- Default native adapter: each function is one raw read and may raise; the caller guards it. Tests replace the adapter.
local function nativeAdapter()
    local N = {}
    -- the car
    function N.vehicle(player) return player:GetMountedVehicle() end
    function N.carActive(vehicle) return vehicle:IsRadioReceiverActive() end
    function N.carStation(vehicle) return vehicle:GetRadioReceiverStationName() end
    function N.carTrack(vehicle) return vehicle:GetRadioReceiverTrackName() end
    function N.carIndex(vehicle) return tonumber(vehicle:GetCurrentRadioIndex()) end
    -- the pocket radio
    function N.pocket(player) return player:GetPocketRadio() end
    function N.pocketActive(radio) return radio:IsActive() end
    function N.pocketStation(radio) return radio:GetStationName() end
    function N.pocketTrack(radio) return radio:GetTrackName() end
    function N.pocketIndex(radio) return tonumber(radio:GetStation()) end
    -- A station's name by its index: a global native function (CET exposes script globals under Game., a bare global is the second try).
    function N.stationName(index)
        local viaGame = Game ~= nil and Game.GetRadioStationLocalizedName
        if type(viaGame) == 'function' then return Game.GetRadioStationLocalizedName(index) end
        return GetRadioStationLocalizedName(index)
    end
    -- localisation: the game's own now-playing toast runs the CName through GetLocalizedTextByKey; GetLocalizedText takes the string form
    -- The station's own current track by its index: the pocket radio's GetTrackName is exactly this (pocketRadio.script), so it is also a second way
    -- to the car's song when the receiver's own track name comes back empty. The station id is the data provider's, not the localised key.
    function N.trackByIndex(index)
        local provider = RadioStationDataProvider
        if provider == nil then return nil end
        local key = provider.GetStationNameByIndex(index)
        if key == nil then return nil end
        local viaGame = Game ~= nil and Game.GetRadioStationCurrentTrackName
        if type(viaGame) == 'function' then return Game.GetRadioStationCurrentTrackName(key) end
        return GetRadioStationCurrentTrackName(key)
    end
    function N.localizeKey(value)
        local key = value
        if type(key) == 'string' then key = CName.new(key) end
        return Game.GetLocalizedTextByKey(key)
    end
    function N.localizeText(text) return Game.GetLocalizedText(text) end
    -- a TV
    function N.tvLookAt(player)
        local object = Game.GetTargetingSystem():GetLookAtObject(player, false, false)
        if object ~= nil and object:IsA('TV') then return object end
        return nil
    end
    function N.position(player)
        local at = player:GetWorldPosition()
        return {x = at.x, y = at.y, z = at.z}
    end
    function N.distance(player, entity)
        local a, b = player:GetWorldPosition(), entity:GetWorldPosition()
        local dx, dy, dz = a.x - b.x, a.y - b.y, a.z - b.z
        return math.sqrt(dx * dx + dy * dy + dz * dz)
    end
    -- One targeting query, the pattern of mod/companion-passage.lua findDoor (that query is proven to return devices: it finds doors). Secondary
    -- targets are asked for too, because a device's targeting component may be one (the owned-car search needs them for the same reason).
    -- The parts come in no order and an NPC brings many of them, so the old limit of 40 parts could fill up with Judy and Alex before a TV came
    -- by (the apartment test of 2026-10-25: tv=none(query found 0 TVs) with a TV on and talking); now every part up to `limit` is looked at.
    -- Returns the TVs among the parts (each entity once) and, for probe.log, what the query saw: {parts =, objects =, classes = 'Door:3,Light:2'}.
    function N.isTv(entity)
        if entity:IsA('TV') then return true end
        -- A TV under another class name still has the TV's device controller.
        local ok, ps = pcall(function() return entity:GetDevicePS() end)
        if ok and ps ~= nil then
            local isController = false
            pcall(function() isController = ps:IsA('TVControllerPS') == true end)
            return isController
        end
        return false
    end
    function N.tvQuery(player, radius, limit)
        local query = TargetSearchQuery.new()
        query.testedSet = Enum.new('TargetingSet', 'Complete')
        query.maxDistance = radius
        query.filterObjectByDistance = true
        query.ignoreInstigator = true
        query.includeSecondaryTargets = true
        local _, parts = Game.GetTargetingSystem():GetTargetParts(player, query)
        local list, seen, counts, order = {}, {}, {}, {}
        local stats = {parts = 0, objects = 0}
        for index, part in ipairs(parts or {}) do
            if index > limit then stats.cut = true; break end
            stats.parts = index
            local ok, entity = pcall(function() return part:GetComponent():GetEntity() end)
            if not ok or entity == nil then
                ok, entity = pcall(function() return TS_TargetPartInfo.GetComponent(part):GetEntity() end)
            end
            if ok and entity ~= nil then
                local id = tostring(entity:GetEntityID().hash)
                if not seen[id] then
                    seen[id] = true
                    stats.objects = stats.objects + 1
                    local read, isTv = pcall(N.isTv, entity)
                    if read and isTv == true then
                        list[#list + 1] = entity
                    else
                        local named, class = pcall(function() return entity:GetClassName() end)
                        class = named and nameText(class) or '?'
                        if counts[class] == nil then counts[class] = 0; order[#order + 1] = class end
                        counts[class] = counts[class] + 1
                    end
                end
            end
        end
        table.sort(order, function(a, b) if counts[a] ~= counts[b] then return counts[a] > counts[b] end return a < b end)
        local rows = {}
        for index = 1, math.min(#order, 6) do rows[index] = order[index] .. ':' .. counts[order[index]] end
        stats.classes = table.concat(rows, ',')
        return list, stats
    end
    -- Whether a TV is on and its channel. GetActiveStationIndex can initialise a TV that never was (it picks a channel), so it is read only for
    -- a TV that is already on, powered and enabled.
    function N.tvState(entity)
        local ps = entity:GetDevicePS()
        if ps == nil then return nil end
        local state = {on = ps:IsON() == true}
        if not state.on then return state end
        local okPower, unpowered = pcall(function() return ps:IsUnpowered() end)
        local okDisabled, disabled = pcall(function() return ps:IsDisabled() end)
        if (okPower and unpowered == true) or (okDisabled and disabled == true) then state.on = false; return state end
        local okIndex, index = pcall(function() return ps:GetActiveStationIndex() end)
        if okIndex and tonumber(index) then
            state.index = tonumber(index)
            local okName, key = pcall(function() return ps:GetChannelName(state.index) end)
            if okName then state.key = key end
        end
        return state
    end
    -- The channel's name from its TweakDB record, when the channel name key would not resolve.
    function N.tvChannelRecord(entity, index)
        local data = entity:GetDevicePS():GetChannelData(index)
        local record = TweakDBInterface.GetChannelDataRecord(data.channelTweakID)
        return record and record:LocalizedName()
    end
    -- The last thing a TV said, from the ring mod/game-dialogue.lua keeps (empty unless the Music and TV switch is on).
    -- The TV a TV line came from (its subtitle's speaker, kept by mod/game-dialogue.lua beside the line ring): the entity ID, the line's age and
    -- the speaker's class. The targeting query does not list a TV at all (live 2026-10-25: parts=13 objects=3 seen=NPCPuppet:2,GenericDevice:1
    -- beside a TV that was on and talking), so a TV that spoke this session is found by its ID instead.
    function N.tvHeard(maxAge)
        local dialogue = convaiGameDialogue
        if type(dialogue) == 'table' and type(dialogue.heardTv) == 'function' then return dialogue:heardTv(maxAge) end
        return nil
    end
    function N.entityById(id) return Game.FindEntityByID(id) end
    -- The song from the game's own song-change events (mod/media-song.lua, installed by init.lua only while the switch is on).
    function N.cachedSong(stationKey)
        local songs = convaiMediaSong
        if type(songs) == 'table' and type(songs.song) == 'function' then return songs:song(stationKey) end
        return nil, 'event:off'
    end
    function N.tvLine(maxAge)
        local dialogue = convaiGameDialogue
        if type(dialogue) == 'table' and type(dialogue.heardMedia) == 'function' then return dialogue:heardMedia(maxAge) end
        return nil
    end
    -- The last line or two the radio host said on this receiver ('car' or 'pocket'), from the radio ring mod/game-dialogue.lua keeps beside the TV's.
    function N.radioLine(maxAge, source)
        local dialogue = convaiGameDialogue
        if type(dialogue) == 'table' and type(dialogue.heardRadioLines) == 'function' then return dialogue:heardRadioLines(maxAge, source) end
        return nil
    end
    -- The mod's probe.log (and console) line, the one the turn-context uses.
    function N.log(line)
        local log = convaiLogLine
        if type(log) == 'function' then log(line) end
    end
    return N
end
M.adapter = nativeAdapter

local Instance = {}
Instance.__index = Instance

-- options: native (adapter override), log(line) (replaces the adapter's).
function M.new(options)
    options = options or {}
    return setmetatable({options = options, native = options.native or nativeAdapter(), lastKey = nil, logs = 0}, Instance)
end

-- A localisation value (CName or string) as readable text: {raw =, text =, via =}. text is nil when nothing readable came out.
local function readable(text, raw)
    if type(text) ~= 'string' then return nil end
    local shown = clean(text, M.MAX_TEXT)
    if not shown or shown == raw or shown:find('^LocKey') then return nil end
    return shown
end
function Instance:resolve(value)
    if value == nil then return nil end
    local N = self.native
    local raw = nameText(value)
    if raw == 'None' then return nil end
    if raw == nil or raw == '' then
        -- A CName whose text CET does not know (a song's): still a key the game localises by its hash, as its own now-playing toast does.
        local hash = nameHash(value)
        if hash == nil then return nil end
        raw = '#' .. hash
        local byHash = readable(call(N.localizeKey, value), raw)
        if byHash then return {raw = raw, text = byHash, via = 'ByKey'} end
        return {raw = raw, via = 'unresolved'}
    end
    local text = readable(call(N.localizeKey, value), raw)
    if text then return {raw = raw, text = text, via = 'ByKey'} end
    text = readable(call(N.localizeText, raw), raw)
    if text then return {raw = raw, text = text, via = 'Text'} end
    -- A key is never spelled with spaces: text with a space in it is already a name (a mod's own station, say).
    if raw:find('%s') and not raw:find('LocKey', 1, true) then
        local shown = clean(raw, M.MAX_TEXT)
        if shown then return {raw = raw, text = shown, via = 'raw'} end
    end
    return {raw = raw, via = 'unresolved'}
end

-- The station named by its index (a fallback for a receiver that gives no station name).
function Instance:stationByIndex(index)
    if type(index) ~= 'number' or index < 1 then return nil end
    local found = self:resolve(call(self.native.stationName, index))
    if found and found.text then found.via = 'index/' .. found.via end
    return found
end

-- The song: the receiver's own track name; when that gives nothing (the live pass of 2026-10-25 read the station but never the track from either
-- radio), the station's current track by its index, then the song the game's own song-change event carried (mod/media-song.lua) while it is
-- still the tuned station's and young. `detail.trackWhy` says, in codes for probe.log, how each route went: the first read (raised, nil,
-- None, a name, or `unnamed` for a CName with a hash and no text), then the event cache (event:off, none, empty, old, otherStation, unresolved).
function Instance:track(detail, holder, read, readIndex, station)
    local N = self.native
    local ok, value = pcall(read, holder)
    local found = ok and self:resolve(value) or nil
    if found and found.text then return found end
    local first
    if not ok then first = 'error:' .. tostring(value):sub(1, 60)
    elseif value == nil then first = 'none:nil'
    elseif found then first = 'none:' .. tostring(found.raw)
    else
        local name = nameText(value)
        first = 'none:' .. ((name == nil or name == '') and 'unnamed' or name)
    end
    local byIndex = self:resolve(call(N.trackByIndex, call(readIndex, holder)))
    if byIndex and byIndex.text then byIndex.via = 'index/' .. byIndex.via; return byIndex end
    local song, why = call(N.cachedSong, station and station.raw or nil)
    if song ~= nil then
        local byEvent = self:resolve(song)
        if byEvent and byEvent.text then byEvent.via = 'event/' .. byEvent.via; return byEvent end
        why = 'event:unresolved'
    end
    detail.trackWhy = first .. ' ' .. tostring(why or 'event:off')
    return found
end

-- The radio V can hear: the car's receiver while mounted, else the pocket radio. Returns {source, station, track}, the diagnostic table,
-- and whether V is mounted (a TV is not looked for from a car).
function Instance:radio(player, detail)
    local N = self.native
    local vehicle = call(N.vehicle, player)
    if vehicle ~= nil then
        detail.radio = 'car'
        local active = call(N.carActive, vehicle)
        if active ~= true then detail.radio = active == false and 'car:inactive' or 'car:unknown'; return nil, true end
        local station = self:resolve(call(N.carStation, vehicle))
        local track = self:track(detail, vehicle, N.carTrack, N.carIndex, station)
        if not (station and station.text) then station = self:stationByIndex(call(N.carIndex, vehicle)) or station end
        detail.station, detail.track = station, track
        if not ((station and station.text) or (track and track.text)) then detail.radio = 'car:unresolved'; return nil, true end
        return {source = 'car', station = station and station.text, track = track and track.text}, true
    end
    local radio = call(N.pocket, player)
    if radio == nil then detail.radio = 'pocket:none'; return nil, false end
    detail.radio = 'pocket'
    local active = call(N.pocketActive, radio)
    if active ~= true then detail.radio = active == false and 'pocket:inactive' or 'pocket:unknown'; return nil, false end
    local station = self:resolve(call(N.pocketStation, radio))
    local track = self:track(detail, radio, N.pocketTrack, N.pocketIndex, station)
    if not (station and station.text) then station = self:stationByIndex(call(N.pocketIndex, radio)) or station end
    detail.station, detail.track = station, track
    if not ((station and station.text) or (track and track.text)) then detail.radio = 'pocket:unresolved'; return nil, false end
    return {source = 'pocket', station = station and station.text, track = track and track.text}, false
end

-- The nearest TV that is on within TV_RADIUS: the one V looks at, else the TV that last spoke (remembered from its
-- subtitle), else the nearest of one targeting query. Returns the entity, its state and distance.
function Instance:findTv(player, detail)
    local N = self.native
    local function consider(entity)
        local distance = call(N.distance, player, entity)
        if type(distance) ~= 'number' or distance > M.TV_RADIUS then return nil end
        local state = call(N.tvState, entity)
        if type(state) == 'table' and state.on == true then return state, distance end
        return nil
    end
    local looked = call(N.tvLookAt, player)
    if looked ~= nil then
        local state, distance = consider(looked)
        if state then detail.tv = 'lookat'; return looked, state, distance end
        detail.lookedOff = true
    end
    -- The TV that last spoke (its subtitle's speaker): one FindEntityByID, no search. It must still be near and on.
    local heardId, _, speakerClass = call(N.tvHeard, M.TV_MEMORY)
    detail.speaker = speakerClass
    if heardId ~= nil then
        local entity = call(N.entityById, heardId)
        if entity == nil then detail.heardTv = 'gone'
        else
            local state, distance = consider(entity)
            if state then detail.tv = 'speaker'; return entity, state, distance end
            detail.heardTv = 'farOrOff'
        end
    end
    -- The last query found nothing and V has not moved far: the same answer (the seam is optional; without it every read queries).
    local origin = call(N.position, player)
    local clock = self.options.clock or os.clock
    local rest = self.tvRest
    if rest and type(origin) == 'table' and clock() >= rest.at and clock() - rest.at < M.QUERY_REST then
        local dx, dy, dz = origin.x - rest.x, origin.y - rest.y, origin.z - rest.z
        if dx * dx + dy * dy + dz * dz <= M.QUERY_MOVE * M.QUERY_MOVE then
            detail.queried, detail.stats, detail.rested = rest.queried, rest.stats, true
            return nil
        end
    end
    self.tvRest = nil
    local list, stats = call(N.tvQuery, player, M.TV_RADIUS, M.QUERY_PARTS)
    detail.queried = type(list) == 'table' and #list or -1
    if type(stats) == 'table' then detail.stats = stats end
    if type(list) ~= 'table' or #list == 0 then
        if type(list) == 'table' and type(origin) == 'table' then
            self.tvRest = {at = clock(), x = origin.x, y = origin.y, z = origin.z, queried = detail.queried, stats = detail.stats}
        end
        return nil
    end
    -- Nearest first, and at most TV_CANDIDATES asked whether they are on. What rejected the others is counted for probe.log.
    local rows = {}
    detail.far = 0
    for _, entity in ipairs(list) do
        local distance = call(N.distance, player, entity)
        if type(distance) == 'number' and distance <= M.TV_RADIUS then rows[#rows + 1] = {entity = entity, distance = distance}
        else detail.far = detail.far + 1 end
    end
    table.sort(rows, function(a, b) return a.distance < b.distance end)
    detail.off = 0
    for index = 1, math.min(#rows, M.TV_CANDIDATES) do
        local state = call(N.tvState, rows[index].entity)
        if type(state) == 'table' and state.on == true then detail.tv = 'query'; return rows[index].entity, state, rows[index].distance end
        detail.off = detail.off + 1
    end
    -- TVs near but none on: rests like an empty query (a TV switched on in the next seconds is one V looks at, or one that speaks).
    if type(origin) == 'table' then
        self.tvRest = {at = clock(), x = origin.x, y = origin.y, z = origin.z, queried = detail.queried, stats = detail.stats}
    end
    return nil
end

-- Why no TV was found, for the end of the probe.log line (not part of the line's key): what the query looked at and which check turned TVs away.
local function whyNone(detail)
    local bits = {}
    local stats = detail.stats
    if type(stats) == 'table' then
        bits[#bits + 1] = 'parts=' .. tostring(stats.parts) .. (stats.cut and '+' or '')
        bits[#bits + 1] = 'objects=' .. tostring(stats.objects)
        if stats.classes and stats.classes ~= '' then bits[#bits + 1] = 'seen=' .. stats.classes end
    end
    if detail.far and detail.far > 0 then bits[#bits + 1] = 'beyondRadius=' .. detail.far end
    if detail.off and detail.off > 0 then bits[#bits + 1] = 'notOn=' .. detail.off end
    if detail.lookedOff then bits[#bits + 1] = 'lookedAtTvNotOn' end
    -- The TV remembered from its subtitle: gone (no longer in the world) or farOrOff; and what spoke the last TV line (a class, or none).
    if detail.heardTv then bits[#bits + 1] = 'heardTv=' .. detail.heardTv end
    if detail.speaker then bits[#bits + 1] = 'tvSpeaker=' .. tostring(detail.speaker) end
    return #bits > 0 and table.concat(bits, ' ') or nil
end

-- A TV near V that is on: {channel =, said =} or nil.
function Instance:tv(player, detail)
    local N = self.native
    local entity, state, distance = self:findTv(player, detail)
    local function heard(age)
        local text = call(N.tvLine, age)
        return type(text) == 'string' and clean(text, M.MAX_TEXT) or nil
    end
    if not entity then
        -- No TV located, but one just spoke and its subtitle only shows near V.
        local recent = heard(M.HEARD_AGE)
        if recent then detail.tv, detail.said, detail.why = 'heard', true, whyNone(detail); return {said = recent} end
        local queried = detail.queried
        detail.tv = 'none(' .. (queried == nil and 'no query' or queried < 0 and 'query failed' or ('query found ' .. queried .. ' TVs')) .. ')'
        detail.why = whyNone(detail)
        return nil
    end
    local said = heard(M.SAID_AGE)
    detail.distance, detail.said = distance, said ~= nil
    local channel = self:resolve(state.key)
    if not (channel and channel.text) and state.index ~= nil then
        local viaRecord = self:resolve(call(N.tvChannelRecord, entity, state.index))
        if viaRecord and viaRecord.text then viaRecord.via = 'record/' .. viaRecord.via; channel = viaRecord end
    end
    detail.channel = channel
    return {channel = channel and channel.text, said = said}
end

local function piece(label, found)
    if found == nil then return label .. '=none' end
    return string.format('%s=[%s]->[%s](%s)', label, tostring(found.raw), tostring(found.text), tostring(found.via))
end
local function safe(text) return (tostring(text):gsub('%c', ' '):sub(1, 400)) end

-- One probe.log line per distinct reading (not per read): the line says what was read from which native, and what the words were.
function Instance:report(detail)
    if self.logs >= M.MAX_LOGS then return end
    local parts = {'Media:', 'radio=' .. tostring(detail.radio or 'unread')}
    if detail.station or detail.track then
        parts[#parts + 1] = piece('station', detail.station)
        parts[#parts + 1] = piece('track', detail.track)
        if detail.trackWhy and not (detail.track and detail.track.text) then parts[#parts + 1] = 'trackWhy=' .. detail.trackWhy end
    end
    if detail.tv then
        parts[#parts + 1] = 'tv=' .. detail.tv
        if detail.channel then parts[#parts + 1] = piece('channel', detail.channel) end
    end
    local key = table.concat(parts, ' ')
    if key == self.lastKey then return end
    self.lastKey = key
    self.logs = self.logs + 1
    -- Distance and whether a line was heard change all the time: they join the line, not the key.
    local line = key
    if detail.distance then line = line .. string.format(' distance=%.1f', detail.distance) end
    if detail.tv then line = line .. ' said=' .. (detail.said and 'yes' or 'no') end
    if detail.radioSaid ~= nil then line = line .. ' hostSaid=' .. (detail.radioSaid and 'yes' or 'no') end
    if detail.why then line = line .. ' why: ' .. detail.why end
    local log = self.options.log or self.native.log
    if type(log) == 'function' then pcall(log, safe(line)) end
end

-- The table for the bridge, or nil when nothing is playing or on. Every part is optional and guarded.
function Instance:read(player)
    if player == nil then return nil end
    local detail = {}
    local ok, radio, mounted = pcall(self.radio, self, player, detail)
    if not ok then radio, mounted, detail.radio = nil, false, 'radio:error' end
    local tv
    if not mounted then
        local read, value = pcall(self.tv, self, player, detail)
        if read then tv = value else detail.tv = 'tv:error' end
    else
        detail.tv = 'skipped(in a vehicle)'
    end
    -- What the radio host just said (a broadcast line, see mod/game-dialogue.lua noteRadio), told with the radio that is on and no other.
    if radio then
        local text = call(self.native.radioLine, M.SAID_AGE, radio.source)
        local said = type(text) == 'string' and clean(text, M.MAX_RADIO_SAID) or nil
        radio.said, detail.radioSaid = said, said ~= nil
    end
    pcall(self.report, self, detail)
    if not radio and not tv then return nil end
    return {radio = radio, tv = tv}
end

-- The module's own instance, for init.lua's lazy loader: M.read(player).
local default
function M.read(player)
    if default == nil then default = M.new({}) end
    return default:read(player)
end

return M
