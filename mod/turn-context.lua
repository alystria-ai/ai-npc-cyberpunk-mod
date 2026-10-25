-- What is going on around V right now, for mod conversations (docs/DYNAMIC_CONTEXT_AUDIT.md, bridge/turn-context.mjs):
-- the game clock, the district, who is with V and whether V is in a vehicle, and V's gender and lifepath.
-- Read-only and on demand, in the style of player-gear.lua: the snapshot is read when a conversation turn is built and reused
-- for MAX_AGE seconds, never per frame, with no timer, hook, observer or file. Every native call is guarded; a failure drops
-- that one field (or the whole snapshot), never the turn. It hands plain values to the bridge, which words them.
-- Each companion row also says what that companion is physically doing right now (following V on foot, sitting, riding or driving,
-- fighting), and V says whether V is driving and how V is moving, so the model never invents an activity or a place for her.
-- Added 2026-10-14: weather, V's health band, the police heat stage and a rough money band. Their CET calls are NOT
-- confirmed in game (see TODO.md, "Live checks"): each is read through guarded, cached lookups of candidate names, logs
-- one line per failure kind (once), and after three straight errors is skipped until the next reset. No native plugin
-- sense exists for any of them, so they are Lua reads at turn time only (never per frame).
-- Added 2026-10-14: the game's dialogue volume (Master x Dialogue, 0 to 1), read only while V's voice for typed lines is on
-- (options.wantVolume, wired in init.lua); the bridge plays V's line at that level (docs/V_VOICE.md). Cached with the rest.
local M = {}
M.MAX_AGE, M.MAX_PARTY, M.PARTY_RADIUS, M.MAX_NAME = 5, 4, 15, 60

local function clean(value, limit)
    if type(value) ~= 'string' then return nil end
    local text = value:gsub('<[^>]*>', ''):gsub('%c', ' '):gsub('%s+', ' '):match('^%s*(.-)%s*$')
    if text == '' or text:match('^LocKey#') then return nil end
    if #text > limit then
        -- Cut on a UTF-8 boundary, never inside a character.
        local cut = limit - 3
        while cut > 0 and text:byte(cut + 1) and text:byte(cut + 1) >= 0x80 and text:byte(cut + 1) < 0xC0 do cut = cut - 1 end
        text = text:sub(1, cut) .. '...'
    end
    return text
end

-- What one companion is doing, as one short word, from the raw inputs companions.activityInputs keeps (all values the companion
-- modules already hold; nothing is read from the game here):
--   input = {transport = {owned, phase, seat, mountedSeat}, tactic = {kind, phase}, seating = <phase>, behavior = <phase>}
-- following | standing | combat | to-seat | seated | getting-up | passenger | driving | boarding | leaving-car | attacking
local DRIVER_SEAT = 'seat_front_left'
local LEAVING = {leaving = true, unmounting = true, ['waiting-for-native-exit'] = true, ['waiting-for-native-dismount'] = true,
    ['exit-failed'] = true, ['recovery-failed'] = true}
local BOARDING = {releasing = true, ['waiting-to-board'] = true, boarding = true, ['waiting-for-seat'] = true,
    ['boarding-retry'] = true, ['leaving-wrong-seat'] = true, ['waiting-for-driver-seat'] = true}
local TO_SEAT = {approach = true, placing = true, blending = true, settling = true}
local SEATED = {entering = true, seated = true}
local GETTING_UP = {leaving = true, standing = true, exiting = true}
local STANDING = {settled = true, waiting = true, attend = true, attend_step = true, attend_settle = true, attend_turn = true}

function M.classify(input)
    input = type(input) == 'table' and input or {}
    local transport = input.transport
    if type(transport) == 'table' and transport.owned == true then
        local phase = transport.phase
        if phase == 'riding' then
            return (transport.mountedSeat or transport.seat) == DRIVER_SEAT and 'driving' or 'passenger'
        end
        if LEAVING[phase] then return 'leaving-car' end
        if BOARDING[phase] then return 'boarding' end
    end
    -- A character another mod seated in V's vehicle (init.lua convaiSpawnedPeople.riders): the seat the engine reports.
    local mounted = input.mounted
    if type(mounted) == 'table' and type(mounted.seat) == 'string' then
        return mounted.seat == DRIVER_SEAT and 'driving' or 'passenger'
    end
    local tactic = input.tactic
    if type(tactic) == 'table' and tactic.kind == 'fight' then return 'attacking' end
    local seating = input.seating
    if SEATED[seating] then return 'seated' end
    if GETTING_UP[seating] then return 'getting-up' end
    if TO_SEAT[seating] then return 'to-seat' end
    local behavior = input.behavior
    if behavior == 'combat' then return 'combat' end
    if STANDING[behavior] then return 'standing' end
    return 'following'
end

local MOTIONS = {still = true, walking = true, running = true}

local function integer(value, low, high)
    value = tonumber(value)
    if not value or value ~= value or value < low or value > high or value ~= math.floor(value) then return nil end
    return value
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

local function gender(value)
    local text = nameText(value)
    text = type(text) == 'string' and text:lower() or ''
    if text:find('female', 1, true) or text:find('woman', 1, true) then return 'female' end
    if text:find('male', 1, true) or text:find('man', 1, true) then return 'male' end
    return nil
end

-- ---- weather, health, heat, money: word-free classifiers (the bridge words them) ------------------------------------
-- Weather kinds the bridge knows: clear, cloudy, rain, heavy-rain, toxic-rain, fog, smog, sandstorm. `state` is the text of
-- the game's weather state (a preset name such as 24h_weather_light_rain), `rain` the text of the rain intensity enum
-- (NoRain, LightRain, HeavyRain) or a number from 0 to 1. Either may be nil. Unknown words yield nil, never a guess.
function M.weatherKind(state, rain)
    local text = type(state) == 'string' and state:lower() or ''
    local drizzle = type(rain) == 'string' and rain:lower() or ''
    local amount = tonumber(rain)
    local heavy = text:find('heavy', 1, true) or text:find('storm', 1, true) or drizzle:find('heavy', 1, true)
        or (amount and amount >= 0.6)
    if text:find('sand', 1, true) then return 'sandstorm' end
    if text:find('toxic', 1, true) then return 'toxic-rain' end
    if text:find('rain', 1, true) or text:find('drizzle', 1, true) then return heavy and 'heavy-rain' or 'rain' end
    if text:find('fog', 1, true) then return 'fog' end
    if text:find('smog', 1, true) or text:find('pollution', 1, true) then return 'smog' end
    if text:find('cloud', 1, true) then return 'cloudy' end
    if text:find('sun', 1, true) or text:find('clear', 1, true) then return 'clear' end
    if drizzle:find('heavy', 1, true) or (amount and amount >= 0.6) then return 'heavy-rain' end
    if drizzle:find('light', 1, true) or (amount and amount > 0.05) then return 'rain' end
    return nil
end

-- V's health as a band from a percentage (0 to 100).
function M.healthBand(percent)
    percent = tonumber(percent)
    if not percent or percent ~= percent or percent < 0 then return nil end
    if percent > 100 then percent = 100 end
    if percent >= 60 then return 'healthy' end
    if percent >= 30 then return 'hurt' end
    return 'badly-hurt'
end

-- The police heat stage (0 to 5) from a number, an enum value or its text (Heat_3).
function M.heatStage(value)
    local number = tonumber(value)
    if number == nil and type(value) == 'string' then number = tonumber(value:match('Heat_(%d)')) end
    if number == nil and value ~= nil and type(value) ~= 'string' then
        local ok, converted = pcall(function() return EnumInt(value) end)
        number = ok and tonumber(converted) or nil
        if number == nil then
            local okText, text = pcall(tostring, value)
            number = okText and tonumber(tostring(text):match('Heat_(%d)')) or nil
        end
    end
    if not number or number ~= number or number ~= math.floor(number) or number < 0 or number > 5 then return nil end
    return number
end

-- A rough money band from the eddies V holds: the exact number never leaves this function.
function M.moneyBand(eddies)
    eddies = tonumber(eddies)
    if not eddies or eddies ~= eddies or eddies < 0 then return nil end
    if eddies < 250 then return 'broke' end
    if eddies < 2500 then return 'low' end
    if eddies < 50000 then return 'ok' end
    if eddies < 250000 then return 'comfortable' end
    return 'rich'
end

-- Call the first of several candidate method names that answers, remembering which one worked (the lookup is cached in
-- `memo`, so a later turn calls one name). A name that does not exist raises in CET: the last error is raised when none
-- answers. Extra arguments are passed after the object.
local function firstMethod(memo, object, names, ...)
    if object == nil then return nil, 'no object' end
    if memo.name then
        local value = object[memo.name](object, ...)
        return value, memo.name
    end
    local lastError, args = nil, {...}
    for _, name in ipairs(names) do
        local ok, value = pcall(function() return object[name](object, table.unpack(args)) end)
        if ok and value ~= nil then memo.name = name; return value, name end
        if not ok then lastError = value end
    end
    error(lastError or 'no candidate answered', 0)
end

-- An enum value or CName as plain text (nil when unreadable).
local function enumName(value)
    if value == nil then return nil end
    if type(value) == 'string' then return value end
    if type(value) == 'number' then return tostring(value) end
    local ok, text = pcall(function() return Game.NameToString(value) end)
    if ok and type(text) == 'string' and text ~= '' and text ~= 'None' then return text end
    ok, text = pcall(tostring, value)
    if ok and type(text) == 'string' then return text:match('%-%-%[%[%s*(.-)%s*%-%-%]%]') or text end
    return nil
end

-- Default native adapter. Every call is guarded by the caller; tests replace it.
local function nativeAdapter()
    local N = {}
    function N.player() return Game.GetPlayer() end
    function N.ready(player)
        return player ~= nil and player:IsAttached() and not player:IsDeadNoStatPool() and not player:IsReplacer()
    end
    -- The game clock: hour and minute of the day. GameTime is a struct of whole game seconds, so the hour is the same
    -- whichever way it is read; the native accessors come first, the seconds count is the fallback.
    function N.clock()
        local system = Game.GetTimeSystem()
        local stamp = system and system:GetGameTime()
        if stamp == nil then return nil end
        local okHour, hour = pcall(function() return GameTime.Hours(stamp) end)
        local okMinute, minute = pcall(function() return GameTime.Minutes(stamp) end)
        if okHour and okMinute and integer(hour, 0, 23) and integer(minute, 0, 59) then return hour, minute, 'native' end
        local okSeconds, seconds = pcall(function() return stamp.seconds end)
        seconds = okSeconds and tonumber(seconds) or nil
        if not seconds then
            local okTotal, total = pcall(function() return GameTime.GetSeconds(stamp) end)
            seconds = okTotal and tonumber(total) or nil
        end
        if not seconds or seconds ~= seconds or seconds < 0 then return nil end
        seconds = math.floor(seconds) % 86400
        return math.floor(seconds / 3600), math.floor(seconds % 3600 / 60), 'seconds'
    end
    function N.gender(player) return player:GetResolvedGenderName() end
    -- V's voice tone ("brain gender" in the character creator), which can differ from the body. The game picks V's voice lines
    -- and how NPCs address V from it, so V's voice for typed lines follows it. Nil when the state cannot be read.
    function N.voice()
        local state = Game.GetCharacterCustomizationSystem():GetState()
        if not state then return nil end
        return state:IsBrainGenderMale() and 'male' or 'female'
    end
    -- The game's Master volume times its Dialogue volume, 0 to 1 (the same two settings mod/continuous-speech.lua reads for a
    -- companion's voice, from the game's own /audio/volume settings group). Read only while V's voice for typed lines is on (options.wantVolume).
    function N.volume()
        local group = Game.GetSettingsSystem():GetGroup(CName.new('/audio/volume'))
        local master = group:GetVar(CName.new('MasterVolume')):GetValue()
        local dialogue = group:GetVar(CName.new('DialogueVolume')):GetValue()
        if not (tonumber(master) and tonumber(dialogue)) then return nil end
        return master * dialogue / 10000
    end
    function N.lifepath(player)
        local system = Game.GetScriptableSystemsContainer():Get('PlayerDevelopmentSystem')
        local path = system and system:GetLifePath(player)
        if path == nil then return nil end
        for native, normalized in pairs({Nomad = 'nomad', StreetKid = 'streetkid', Corporate = 'corpo'}) do
            if path == Enum.new('gamedataLifePath', native) then return normalized end
        end
        return nil
    end
    function N.vehicle(player) return player:GetMountedVehicle() ~= nil end
    -- The driver's seat is seat_front_left (the same read companion-vehicle-native.lua makes of V's own mount).
    function N.driving(player)
        local info = Game.GetMountingFacility():GetMountingInfoSingleWithObjects(player)
        local seat = info and info.slotId and NameToString(info.slotId.id)
        if type(seat) ~= 'string' then return nil end
        return seat == DRIVER_SEAT
    end
    -- Weather: the game's weather system. The state getter name is unconfirmed, so a few are tried (the working one is
    -- cached); the rain intensity getters give a second opinion. Returns the state text, the rain value and the names that
    -- answered. Plain values only, never a game object.
    local weatherState, weatherRainType, weatherRain = {}, {}, {}
    function N.weather()
        local system = Game.GetWeatherSystem()
        if system == nil then return nil end
        local stateText, rainValue, used = nil, nil, {}
        local okState, state, stateName = pcall(firstMethod, weatherState, system,
            {'GetWeatherState', 'GetActiveWeatherState', 'GetWeatherStateName', 'GetCurrentWeatherState'})
        if okState and state ~= nil then
            stateText = enumName(state)
            if type(state) ~= 'string' and (stateText == nil or stateText:find('^userdata') or stateText:find('^table')) then
                local okField, field = pcall(function() return state.name end)
                stateText = okField and enumName(field) or stateText
            end
            used[#used + 1] = stateName
        end
        local okType, rainType, typeName = pcall(firstMethod, weatherRainType, system, {'GetRainIntensityType'})
        if okType and rainType ~= nil then rainValue = enumName(rainType); used[#used + 1] = typeName end
        if rainValue == nil then
            local okRain, rain, rainName = pcall(firstMethod, weatherRain, system, {'GetRainIntensity'})
            if okRain and rain ~= nil then rainValue = tonumber(rain) or enumName(rain); used[#used + 1] = rainName end
        end
        if #used == 0 then
            error('no weather getter answered (tried GetWeatherState, GetRainIntensityType, GetRainIntensity)', 0)
        end
        return stateText, rainValue, table.concat(used, '+')
    end
    -- Health: percent of V's health pool, 0 to 100 (GetStatPoolValue with percentage = true; the value over the maximum is
    -- the fallback). Returns the percent and which read answered.
    function N.health(player)
        local pools = Game.GetStatPoolsSystem()
        if pools == nil then return nil end
        local id, kind = player:GetEntityID(), Enum.new('gamedataStatPoolType', 'Health')
        local ok, percent = pcall(function() return pools:GetStatPoolValue(id, kind, true) end)
        if ok and tonumber(percent) then return tonumber(percent), 'GetStatPoolValue(percent)' end
        local current = pools:GetStatPoolValue(id, kind, false)
        local maximum = pools:GetStatPoolMaxPointValue(id, kind)
        if tonumber(current) and tonumber(maximum) and tonumber(maximum) > 0 then
            return tonumber(current) / tonumber(maximum) * 100, 'value/max'
        end
        return nil
    end
    -- Heat: the prevention system's current heat stage. Two getter names are tried; the working one is cached.
    local heatGetter = {}
    function N.heat()
        local system = Game.GetScriptableSystemsContainer():Get('PreventionSystem')
        if system == nil then return nil end
        return firstMethod(heatGetter, system, {'GetHeatStageAsInt', 'GetHeatStage'})
    end
    -- Money: V's eddies, the quantity of Items.money in the transaction system (the call loot-observer.lua makes for other
    -- items). The ItemID is built once.
    local moneyId
    function N.money(player)
        if moneyId == nil then moneyId = ItemID.FromTDBID(TweakDBID.new('Items.money')) end
        return Game.GetTransactionSystem():GetItemQuantity(player, moneyId)
    end
    -- Whether V stands inside an interior area. A GLOBAL native function, not a method of the scene system (the first version called
    -- SceneSystemInterface:IsEntityInInteriorArea and failed live 2026-10-15 with "a nil value"; a probe compiled against the 2.31
    -- script cache confirms SceneSystemInterface has no such method). Source: REDmod scripts core/entity/gameEntity.script line 5,
    -- `import function IsEntityInInteriorArea( entity : weak< Entity > ) : Bool;`. The game itself calls it in
    -- cyberpunk/player/psm/weaponTransitions.script (`IsEntityInInteriorArea( GetPlayer( gameInstance ) )`: a gunshot carries 25 m
    -- indoors instead of the weapon's range) and in reactionComponent.script (a safe area AND an interior area). The flag is the level
    -- designers' own interior volumes, so a building V can walk into counts; a bare roof or an overpass is not claimed. One native call,
    -- read only when the turn context is built (never per frame). Plain boolean only: anything else is an error, which the caller logs
    -- once and treats as "not given". CET exposes script globals under Game.; a bare global is the second try.
    local interiorCall
    function N.interior(player)
        if interiorCall == nil then   -- a found function is remembered; "not found" is looked up again on the next read
            local viaGame = Game ~= nil and Game.IsEntityInInteriorArea
            interiorCall = type(viaGame) == 'function' and function(who) return Game.IsEntityInInteriorArea(who) end
                or type(rawget(_G, 'IsEntityInInteriorArea')) == 'function' and function(who) return IsEntityInInteriorArea(who) end
                or nil
        end
        if interiorCall == nil then error('IsEntityInInteriorArea is not exposed by this CET build', 0) end
        local value = interiorCall(player)
        if type(value) ~= 'boolean' then error('IsEntityInInteriorArea answered no boolean', 0) end
        return value, 'IsEntityInInteriorArea'
    end
    return N
end

local Instance = {}
Instance.__index = Instance

-- Dynamic info (Settings > Dynamic info): options.enabled(kind) says whether a kind of live info is on (mod/manager.lua dynamicInfo). A kind that is
-- off is not read from the game at all, so turning one off removes work. The kinds, and what each one covers here:
--   location   the district and the named place, and whether V is indoors     time      the clock and the weather
--   company    who is with V, the vehicle and V's motion                      condition V's health and the police heat
--   money      V's money band                                                  about     V's gender and lifepath
-- (V's voice for typed lines still reads V's voice gender and the dialogue volume: they are no part of the words the bridge writes.)
local KINDS = {'location', 'time', 'company', 'condition', 'money', 'gear', 'about', 'quest', 'dialogue'}

-- options: enabled(kind) -> boolean (default: everything on), activity() -> {rows = {[profileKey] = inputs for M.classify}, motion = 'still'|'walking'|'running'}, now() (seconds), log(line) (one line per real read, never per frame), native (adapter override),
-- place() -> {district =, area =} (init.lua's currentDistrict), party(player, radius) -> {{profileKey =, name =}}.
function M.new(options)
    options = options or {}
    return setmetatable({options = options, native = options.native or nativeAdapter(), snapshot = nil, at = nil,
        lifepath = nil, failures = {}, logged = {}}, Instance)
end

-- After this many straight errors an unconfirmed read (weather, health, heat, money) is skipped until the next reset.
M.MAX_FAILURES = 3

local function call(fn, ...)
    if type(fn) ~= 'function' then return nil end
    local ok, a, b, c = pcall(fn, ...)
    if ok then return a, b, c end
    return nil
end

-- Whether a kind of live info is on. No callback: everything is on; a callback that fails or answers nothing leaves the kind on.
function Instance:wants(kind)
    local enabled = self.options.enabled
    if type(enabled) ~= 'function' then return true end
    local ok, value = pcall(enabled, kind)
    return not ok or value ~= false
end

-- The state of the switches as one short text: a snapshot read under other switches is not reused.
function Instance:switches()
    local parts = {}
    for index, kind in ipairs(KINDS) do parts[index] = self:wants(kind) and '1' or '0' end
    return table.concat(parts)
end

function Instance:now()
    local value = self.options.now and self.options.now() or os.time()
    return type(value) == 'number' and value or os.time()
end

-- A new save, a death or a reload: drop the cache and the lifepath (a different save may be a different V).
function Instance:reset(reason)
    self.snapshot, self.at, self.lifepath, self.resetReason = nil, nil, nil, reason
    self.failures = {}   -- a reset gives the unconfirmed reads another chance; what was already logged stays logged
end

-- One diagnostic line per failure kind, ever (not per read): `key` names the kind.
function Instance:once(key, line)
    if self.logged[key] then return end
    self.logged[key] = true
    if type(self.options.log) == 'function' then pcall(self.options.log, line) end
end

-- An unconfirmed native read (weather, health, heat, money): guarded, skipped after M.MAX_FAILURES straight errors, and
-- every failure kind (error, answered nothing) logged once. Returns what the adapter returned, or nil.
function Instance:optional(kind, ...)
    local fn = self.native[kind]
    if type(fn) ~= 'function' then return nil end
    if (self.failures[kind] or 0) >= M.MAX_FAILURES then return nil end
    local ok, a, b, c = pcall(fn, ...)
    if not ok then
        self.failures[kind] = (self.failures[kind] or 0) + 1
        self:once(kind .. ':error', 'Turn context: ' .. kind .. ' read failed (' .. tostring(a):gsub('%s+', ' '):sub(1, 160) .. ')')
        return nil
    end
    self.failures[kind] = 0
    if a == nil and b == nil then self:once(kind .. ':empty', 'Turn context: ' .. kind .. ' read answered nothing') end
    return a, b, c
end

local function placeName(value)
    return type(value) == 'string' and value:match('^[A-Za-z0-9][A-Za-z0-9 _.\'-]*$') and #value <= 64 and value or nil
end

function Instance:read()
    local N = self.native
    local player = call(N.player)
    if not player or not call(N.ready, player) then return nil, 'V is not ready (loading, dead or in a flashback)' end
    local snapshot, count = {version = 1, status = 'ready'}, 0
    local clockSource
    local wantTime, wantPlace, wantAbout = self:wants('time'), self:wants('location'), self:wants('about')
    local wantCompany, wantCondition, wantMoney = self:wants('company'), self:wants('condition'), self:wants('money')
    local hour, minute, source
    if wantTime then hour, minute, source = call(N.clock) end
    if integer(hour, 0, 23) and integer(minute, 0, 59) then
        snapshot.hour, snapshot.minute, clockSource = hour, minute, source
        count = count + 1
    end
    local place = wantPlace and call(self.options.place) or nil
    if type(place) == 'table' then
        local district, area = placeName(place.district), placeName(place.area)
        if district then
            snapshot.district, snapshot.area = district, area ~= district and area or nil
            count = count + 1
        end
    end
    local sex = wantAbout and gender(call(N.gender, player)) or nil
    if sex then snapshot.gender = sex; count = count + 1 end
    -- Not counted as something read: only V's voice for typed lines uses it, never the words the bridge writes.
    local tone = gender(call(N.voice, player))
    if tone then snapshot.voice = tone end
    -- The game's dialogue loudness, for V's voice for typed lines only (options.wantVolume). Not counted as something read: it
    -- is no part of the words the bridge writes, and a snapshot that holds only it is no snapshot.
    self.volumeWanted = call(self.options.wantVolume) == true
    if self.volumeWanted then
        local level = self:optional('volume')
        if type(level) == 'number' and level == level and level >= 0 and level <= 1 then
            snapshot.dialogueVolume = math.floor(level * 100 + 0.5) / 100
        end
    end
    -- The lifepath is fixed for a save: read once, and again only while it is unknown.
    if wantAbout and not self.lifepath then self.lifepath = call(N.lifepath, player) end
    if wantAbout and type(self.lifepath) == 'string' and self.lifepath:match('^[a-z]+$') then
        snapshot.lifepath = self.lifepath
        count = count + 1
    end
    local mounted
    if wantCompany then mounted = call(N.vehicle, player) end
    if type(mounted) == 'boolean' then snapshot.vehicle = mounted; count = count + 1 end
    if mounted == true then
        local driving = call(N.driving, player)
        if type(driving) == 'boolean' then snapshot.driving = driving end
    end
    -- Weather, V's health band, the heat stage and a money band (unconfirmed calls: guarded, logged once per failure kind).
    -- `extras` is what the one diagnostic line adds so a live pass can check each against the game.
    local extras = {}
    local stateText, rainValue, weatherSource
    if wantTime then stateText, rainValue, weatherSource = self:optional('weather') end
    if stateText ~= nil or rainValue ~= nil then
        local kind = M.weatherKind(stateText, rainValue)
        if kind then
            snapshot.weather = kind; count = count + 1
            extras[#extras + 1] = string.format('weather=%s(%s|%s|%s)', kind, tostring(stateText), tostring(rainValue), tostring(weatherSource))
        else
            self:once('weather:unmapped', string.format('Turn context: weather not recognised (state=%s rain=%s)', tostring(stateText), tostring(rainValue)))
        end
    end
    local percent, healthSource
    if wantCondition then percent, healthSource = self:optional('health', player) end
    local band = M.healthBand(percent)
    if band then
        snapshot.health = band; count = count + 1
        extras[#extras + 1] = string.format('health=%s(%d%%|%s)', band, math.floor(tonumber(percent) + 0.5), tostring(healthSource))
    elseif percent ~= nil then
        self:once('health:unmapped', 'Turn context: health value not usable (' .. tostring(percent) .. ')')
    end
    local rawHeat, heatSource
    if wantCondition then rawHeat, heatSource = self:optional('heat') end
    local stage = M.heatStage(rawHeat)
    if stage then
        snapshot.heat = stage; count = count + 1
        extras[#extras + 1] = string.format('heat=%d(%s)', stage, tostring(heatSource))
    elseif rawHeat ~= nil then
        self:once('heat:unmapped', 'Turn context: heat value not usable (' .. tostring(rawHeat) .. ')')
    end
    -- Inside a building or not (unconfirmed, optional; it only sharpens the place wording, so it is not counted as something read).
    if snapshot.district then
        local inside, insideSource = self:optional('interior', player)
        if type(inside) == 'boolean' then
            snapshot.indoors = inside
            extras[#extras + 1] = string.format('indoors=%s(%s)', tostring(inside), tostring(insideSource))
        elseif type(self.native.interior) == 'function' then
            extras[#extras + 1] = 'indoors=unknown'   -- no claim either way: with vision on the picture decides (bridge/convai-vision.mjs VISION_NOTE)
        end
    end
    local eddies
    if wantMoney then eddies = self:optional('money', player) end
    local money = M.moneyBand(eddies)
    if money then
        snapshot.money = money; count = count + 1
        extras[#extras + 1] = string.format('money=%s(%d)', money, math.floor(tonumber(eddies)))
    elseif eddies ~= nil then
        self:once('money:unmapped', 'Turn context: money value not usable (' .. tostring(eddies) .. ')')
    end
    local rows = wantCompany and call(self.options.party, player, M.PARTY_RADIUS) or nil
    if type(rows) == 'table' then
        local party, seen = {}, {}
        for _, row in ipairs(rows) do
            local key, name = type(row) == 'table' and row.profileKey or nil, type(row) == 'table' and clean(row.name, M.MAX_NAME) or nil
            if type(key) == 'string' and key:match('^[a-z0-9%-]+$') and #key <= 80 and name and not seen[key] and #party < M.MAX_PARTY then
                seen[key] = true
                party[#party + 1] = {key = key, name = name}
            end
        end
        if #party > 0 then
            -- What each companion is doing, and how V moves (the companion modules' own state; one read per turn window).
            local info = call(self.options.activity)
            if type(info) == 'table' then
                for _, row in ipairs(party) do
                    local inputs = type(info.rows) == 'table' and info.rows[row.key] or nil
                    if type(inputs) == 'table' then
                        row.activity = M.classify(inputs)
                        -- Clothes other than the ones her appearance text describes (mod/companion-outfits.lua): 'home' or 'changed'.
                        if inputs.outfit == 'home' or inputs.outfit == 'changed' then row.outfit = inputs.outfit end
                    end
                end
                if MOTIONS[info.motion] and not snapshot.vehicle then snapshot.motion = info.motion end
            end
            snapshot.party = party; count = count + 1
        end
    end
    -- With a Dynamic info switch off there may be nothing to say and still something for V's voice for typed lines (its gender, the dialogue
    -- volume): that much is kept. With every switch on, a snapshot of those alone is no snapshot.
    local anyOff = not (wantTime and wantPlace and wantAbout and wantCompany and wantCondition and wantMoney)
    if count == 0 and not (anyOff and (snapshot.voice ~= nil or snapshot.dialogueVolume ~= nil)) then return nil, 'nothing could be read' end
    return snapshot, count, clockSource, extras
end

-- The snapshot for this turn, or nil. Reused for MAX_AGE seconds so a burst of turns (a group round, a voice start and
-- finish) reads the game once. A failed or empty read is not cached: the next turn tries again.
function Instance:capture()
    local now = self:now()
    -- A snapshot read while the volume was not wanted is not reused once it is (V's voice just became active), so the first line
    -- after switching to a cloning voice already has the level.
    -- A snapshot read under other Dynamic info switches is not reused either (a kind just turned off must not ride along for up to MAX_AGE).
    local switches = self:switches()
    if self.snapshot and self.at and now >= self.at and now - self.at < M.MAX_AGE and self.switches_ == switches
        and (self.volumeWanted or call(self.options.wantVolume) ~= true) then return self.snapshot end
    self.switches_ = switches
    local ok, snapshot, detail, clockSource, extras = pcall(self.read, self)
    -- One diagnostic line per real read (at most once per window): what the adapter built, so a live pass can compare the
    -- clock with the HUD and the place with the map.
    if type(self.options.log) == 'function' then
        local line
        if ok and snapshot then
            local party = snapshot.party and #snapshot.party or 0
            line = string.format('Turn context: %s %s %s %s vehicle=%s party=%d',
                snapshot.hour and string.format('%02d:%02d(%s)', snapshot.hour, snapshot.minute, tostring(clockSource)) or 'no-clock',
                snapshot.district and (snapshot.district .. (snapshot.area and ('/' .. snapshot.area) or '')) or 'no-place',
                snapshot.gender or 'no-gender', snapshot.lifepath or 'no-lifepath',
                snapshot.vehicle == nil and 'unknown' or tostring(snapshot.vehicle), party)
            -- What each companion was found doing, and V's motion (only when there was something to say).
            local doing = {}
            for _, row in ipairs(snapshot.party or {}) do
                if row.activity then doing[#doing + 1] = row.key .. '=' .. row.activity .. (row.outfit and ('+' .. row.outfit) or '') end
            end
            if #doing > 0 then line = line .. ' activity=' .. table.concat(doing, ',') end
            if snapshot.driving ~= nil then line = line .. ' driving=' .. tostring(snapshot.driving) end
            if snapshot.motion then line = line .. ' v=' .. snapshot.motion end
            -- Weather, health, heat and money, each with the raw reading and the getter that answered.
            if type(extras) == 'table' and #extras > 0 then line = line .. ' ' .. table.concat(extras, ' ') end
        else
            line = 'Turn context: none (' .. tostring(ok and detail or snapshot):sub(1, 160) .. ')'
        end
        pcall(self.options.log, line)
    end
    if not ok or not snapshot then self.snapshot, self.at = nil, nil; return nil end
    self.snapshot, self.at = snapshot, now
    return snapshot
end

return M
