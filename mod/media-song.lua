-- Music and TV, the song (docs/DYNAMIC_INFO.md "Music and TV"): the game's own song-change events, cached for mod/media-context.lua.
-- The live pass of 2026-10-25 read the station on both radios but never the song, so the song is also taken from the events the game's own
-- radio UI is driven by. Each one fires once per song (or station change), never per frame; the callback only stores {song, station, at}.
-- The names below come from the game's script cache (vendor/compiler-cache/final.redscripts, the cache the compile checks use):
--   VehicleSummonWidgetGameController.OnVehicleRadioSongChanged(evt: ref<VehicleRadioSongChanged>)   the HUD's now-playing toast; its own
--     TryShowVehicleRadioNotification then runs GetLocalizedTextByKey(vehicle.GetRadioReceiverTrackName())
--   VehicleRadioPopupGameController.OnVehicleRadioSongChanged(evt)   the radio list while it is open; it shows SetTrackName(evt.radioSongName)
--   PlayerPuppet.OnVehicleRadioStationChanged(evt: ref<VehicleRadioStationChanged>)   carries radioStationName and radioSongName
-- (VehicleRadioSongChanged.radioSongName and VehicleRadioStationChanged.radioSongName are CNames, vendor/reference-game-scripts
-- core/gameplay/vehicleRadio.script lines 1-12.) Installed only while Settings > Dynamic info > Music and TV is on (init.lua installs it at
-- start with the switch on, or at the first turn built with it on); a class or event that does not exist logs once and does nothing.
-- With the switch off the callbacks return after one boolean read, and nothing is loaded at all if it was never on.
local M = {}
M.MAX_AGE = 360   -- seconds: a song this old is over (songs are short)
M.HOOKS = {
    {'VehicleSummonWidgetGameController', 'OnVehicleRadioSongChanged'},
    {'VehicleRadioPopupGameController', 'OnVehicleRadioSongChanged'},
    {'PlayerPuppet', 'OnVehicleRadioStationChanged'},
}

local function call(fn, ...)
    if type(fn) ~= 'function' then return nil end
    local ok, a = pcall(fn, ...)
    if ok then return a end
    return nil
end

-- Default native adapter: each function is one raw read and may raise. Tests replace it.
local function nativeAdapter()
    local N = {}
    function N.songOf(evt) return evt.radioSongName end
    function N.stationOf(evt) return evt.radioStationName end
    -- The station tuned now, the same read media-context.lua makes: the car receiver while mounted, else the pocket radio.
    function N.station()
        local player = Game.GetPlayer()
        if player == nil then return nil end
        local vehicle = player:GetMountedVehicle()
        if vehicle ~= nil then
            if vehicle:IsRadioReceiverActive() ~= true then return nil end
            return vehicle:GetRadioReceiverStationName()
        end
        local radio = player:GetPocketRadio()
        if radio == nil or radio:IsActive() ~= true then return nil end
        return radio:GetStationName()
    end
    function N.log(line)
        local once = convaiLogOnce
        if type(once) == 'function' then once('media-song:' .. line, line) end
    end
    return N
end
M.adapter = nativeAdapter

local Instance = {}
Instance.__index = Instance

-- options: observe(class, method, fn) (ObserveAfter), wanted() (the Music and TV switch), now(), native, key(value) (a CName as text,
-- media-context's nameText), log(line).
function M.new(options)
    options = options or {}
    return setmetatable({options = options, native = options.native or nativeAdapter(), installed = false, hooked = 0, last = nil}, Instance)
end

function Instance:now()
    local now = self.options.now
    if type(now) == 'function' then return now() end
    return os.time()
end

function Instance:key(value)
    if value == nil then return nil end
    local key = self.options.key
    if type(key) == 'function' then return call(key, value) end
    if type(value) == 'string' then return value end
    -- The same text media-context.lua's nameText gives a station key, so the two compare.
    local text = call(function() return Game.NameToString(value) end)
    if type(text) == 'string' and text ~= '' then return text end
    return call(tostring, value)
end

function Instance:log(line)
    local log = self.options.log or self.native.log
    if type(log) == 'function' then pcall(log, line) end
end

-- One song change: the song's CName (kept as it is: its text may be absent from CET's name pool, the hash is what the game localises) and
-- the station tuned now. A change with no song (the vehicle component sends an empty one when the radio is switched on) clears the old song.
function Instance:onEvent(evt, withStation)
    if call(self.options.wanted) ~= true then return end
    local N = self.native
    local song = evt ~= nil and call(N.songOf, evt) or nil
    local station = call(N.station)
    if station == nil and withStation and evt ~= nil then station = call(N.stationOf, evt) end
    local songKey = self:key(song)
    if song == nil or songKey == 'None' then song = nil end
    self.last = {song = song, station = self:key(station), at = self:now()}
    self.events = (self.events or 0) + 1
end

-- Observe each event once; each one guarded on its own, and one that is missing logs once and is skipped.
function Instance:install()
    if self.installed then return self.hooked end
    self.installed = true
    local observe = self.options.observe
    if type(observe) ~= 'function' then self:log('Media song: no observer, the song events are not hooked'); return 0 end
    for _, hook in ipairs(M.HOOKS) do
        local class, method = hook[1], hook[2]
        local withStation = method == 'OnVehicleRadioStationChanged'
        local ok, err = pcall(observe, class, method, function(_, evt) pcall(self.onEvent, self, evt, withStation) end)
        if ok then self.hooked = self.hooked + 1
        else self:log('Media song: ' .. class .. '.' .. method .. ' could not be hooked: ' .. tostring(err):sub(1, 120)) end
    end
    return self.hooked
end

-- The cached song for the station tuned now: the song's CName, or nil and why (a code for probe.log).
function Instance:song(stationKey)
    if not self.installed then return nil, 'event:off' end
    local last = self.last
    if last == nil then return nil, 'event:none' end
    if last.song == nil then return nil, 'event:empty' end
    local age = self:now() - last.at
    if age < 0 or age > M.MAX_AGE then return nil, 'event:old' end
    if stationKey ~= nil and last.station ~= nil and last.station ~= stationKey then return nil, 'event:otherStation' end
    return last.song, 'event'
end

return M
