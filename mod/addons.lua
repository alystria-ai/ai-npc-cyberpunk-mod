-- Add-on API (docs/ADDON_API.md). Separately installed CET mods (Skippy the talking gun, the Delamain cab's voice) register here
-- and get speakers without a body, automatic remarks, context for the prompt, settings and game events. The main mod never
-- needs one: until an add-on registers, `M.live` stays false, init.lua skips every call into this file, and nothing here
-- reads or writes a file, hooks a game function or runs per frame.
--
-- An add-on reaches this table through CET: init.lua returns {addons = <this module's public API>}, so in the add-on's onInit
--     local main = GetMod('CyberpunkConvai'); local api = main and main.addons
-- Everything runs on the main mod's existing 0.1 s tick (M.tick, only while live) and on events the main mod already has.
-- No native object is kept across a save load: anchors are resolved again whenever they are needed.
--
-- How often an add-on speaks is the player's choice (the user's decision, 2026-10-13): "Time between remarks" (4 to 60 s, default 10)
-- and "Most remarks per fight" (5 to 50 or no limit, default 30; outside combat per five minutes), with the last remark of the cap kept
-- for a moment of priority 4 or 5. One remark at a time: nothing new starts while one is written or spoken, and a remark whose moment
-- has passed (about 3 s) is dropped. Add-on speakers' text comes only from Mistral or the local AI.
local M = {API_MAJOR = 1, API_MINOR = 0, live = false}
M.API_VERSION = M.API_MAJOR .. '.' .. M.API_MINOR

local addons, order = {}, {}         -- id -> add-on record, registration order
local speakers = {}                  -- profileKey -> speaker record
local host = nil                     -- functions init.lua provides (M.attach)
local clock = 0                      -- seconds, advanced by M.tick
local queue = {}                     -- waiting remarks
local flight = nil                   -- the add-on request in flight (one at a time, like every automatic turn)
local pendingNotices = {}            -- notices waiting for gameplay
local noticeAt = {}                  -- text -> clock of the last time it was shown
local settingsValues = nil           -- {addonId = {id = value}}, loaded on the first registration
local staged = nil                   -- MCM changes waiting for the main Apply
local stateDirty, stateWrittenAt = false, -10
local watch = {}                     -- last seen game facts, for events
local partyDirty, partyKnown = false, nil
local outputsCache, outputsAt = nil, -10
local lastSpeechEndAt, sessionOpen = -10, false
local bridgeStatusRead = false       -- runtime/addons-status.json is read once, at the first gameplay tick with an add-on
local settingEvents = {}             -- settingChanged events, sent on the next tick (never inside the menu's Apply)

-- Limits shared with the bridge (bridge/addons.mjs ADDON_LIMITS).
local LIMITS = {blocks = 8, blockText = 1500, eventText = 600, companionBlocks = 4, companionText = 600, queue = 6,
    facts = 4000, settings = 24}
local GLOBAL_GAP = 2          -- seconds of quiet after any speech before an add-on remark starts
local LEASE_PERIOD = 1        -- the bridge drops an automatic request whose lease is older than five seconds
-- The two settings every add-on with a speaker gets (values are 1-based indexes into these lists).
local GAPS = {4, 6, 8, 10, 15, 20, 30, 60}             -- "Time between remarks", seconds
local GAP_DEFAULT = 4                                    -- 10 s
local CAPS = {5, 10, 20, 30, 50, math.huge}              -- "Most remarks per fight"; the last is "No limit"
local CAP_DEFAULT = 4                                    -- 30
local DEFAULT_TTL = 3         -- a remark that cannot be heard within about 3 s of its moment is dropped
local EPISODE_IDLE = 300      -- outside combat an episode is a rolling five minutes; a fight is one episode
local PROVIDER_QUIET = 120    -- seconds without remarks after the bridge said no text provider is set up
local MODE_ID = '^[a-z][a-z0-9%-]*$'
local EVENTS = {sessionStarted = true, sessionEnded = true, combatStarted = true, combatEnded = true,
    vehicleEntered = true, vehicleExited = true, sceneStarted = true, sceneEnded = true,
    companionJoined = true, companionLeft = true, turnStarted = true, turnEnded = true,
    speechStarted = true, speechEnded = true, remarkStarted = true, remarkFinished = true, remarkDropped = true,
    settingChanged = true}

local function log(message)
    message = '[Addons] ' .. tostring(message)
    if host and host.log then pcall(host.log, message) else pcall(print, '[CyberpunkConvai] ' .. message) end
end

local function trim(value, limit)
    if type(value) ~= 'string' then return nil end
    value = value:gsub('[%z\1-\8\11\12\14-\31\127]', ' '):match('^%s*(.-)%s*$')
    if value == '' then return nil end
    if limit and #value > limit then value = value:sub(1, limit) end
    return value
end

local function number(value, low, high, default)
    if type(value) ~= 'number' or value ~= value then return default end
    return math.max(low, math.min(high, value))
end

local function parseVersion(value)
    if type(value) ~= 'string' then return nil end
    local major, minor = value:match('^%s*(%d+)%.(%d+)%s*$')
    if not major then return nil end
    return tonumber(major), tonumber(minor)
end

local function encode(value)
    if type(json) ~= 'table' or type(json.encode) ~= 'function' then return nil end
    local ok, text = pcall(json.encode, value)
    return ok and text or nil
end

local function decode(text)
    if type(json) ~= 'table' or type(json.decode) ~= 'function' or type(text) ~= 'string' then return nil end
    local ok, value = pcall(json.decode, text)
    return ok and value or nil
end

local function writeFile(name, text)
    local path = 'runtime/' .. name
    local file = io.open(path .. '.tmp', 'wb')
    if not file then return false end
    file:write(text); file:close()
    os.remove(path)
    return os.rename(path .. '.tmp', path) ~= nil
end

local function readFile(name)
    local file = io.open('runtime/' .. name, 'rb')
    if not file then return nil end
    local text = file:read('*a'); file:close()
    return text
end

-- Handlers run inside pcall; one that keeps failing is removed so it cannot spam the log or cost frames.
local function emitTo(addon, name, payload)
    local list = addon.handlers[name]
    if not list then return end
    for index = #list, 1, -1 do
        local entry = list[index]
        local ok, err = pcall(entry.fn, payload)
        if not ok then
            entry.failures = entry.failures + 1
            log(addon.id .. ': ' .. name .. ' handler failed: ' .. tostring(err))
            if entry.failures >= 3 then table.remove(list, index); log(addon.id .. ': ' .. name .. ' handler removed after three failures') end
        end
    end
end

local function emit(name, payload)
    for _, id in ipairs(order) do
        local addon = addons[id]
        if addon then emitTo(addon, name, payload) end
    end
end

local function subscribed(name)
    for _, id in ipairs(order) do
        local list = addons[id] and addons[id].handlers[name]
        if list and #list > 0 then return true end
    end
    return false
end

local function notify(text)
    if type(text) ~= 'string' or text == '' then return end
    if noticeAt[text] and clock - noticeAt[text] < 10 then return end
    noticeAt[text] = clock
    pendingNotices[#pendingNotices + 1] = text
end

-- ---- Anchors and availability ------------------------------------------------------------------------------------------

local function resolveAnchor(speaker, player)
    local ok, object = pcall(function()
        local anchor = speaker.anchor
        if anchor == 'player' then return player end
        if anchor == 'vehicle' then return player and player:GetMountedVehicle() or nil end
        if type(anchor) == 'function' then return anchor(player) end
        return nil
    end)
    if not ok or not object then return nil end
    local valid, entity = pcall(function()
        if not object:IsAttached() then return nil end
        return tostring(object:GetEntityID().hash)
    end)
    if not valid or type(entity) ~= 'string' or not entity:match('^%d+ULL$') then return nil end
    return object, entity
end

local function speakerAvailable(speaker, player)
    if not speaker.addon.enabled then return false end
    if speaker.available == nil then return true end
    local ok, value = pcall(speaker.available, player)
    return ok and value == true
end

local function sceneBlocked(sample, speaker)
    if type(sample) ~= 'table' or sample.available ~= true then return true, 'observation-unavailable' end
    if sample.dialogue or sample.choices or sample.call or sample.replacer then return true, 'scene' end
    local tiers = speaker and speaker.sceneTiers or {1}
    for _, tier in ipairs(tiers) do if sample.tier == tier then return false end end
    return true, 'scene-tier'
end

local function speakerBlocks(speaker)
    local blocks = {}
    for _, key in ipairs(speaker.contextOrder) do
        local text = speaker.contexts[key]
        if text then blocks[#blocks + 1] = {key = key, text = text, tier = speaker.contextTiers[key] or 'world'} end
    end
    return blocks
end

-- A speaker with stock requests sends its context blocks with them (handle:stock): a change of a block is a change of the file.
local function stockTouch(speaker)
    if speaker.stockOrder and #speaker.stockOrder > 0 then stateDirty = true end
end

-- ---- The request in flight -------------------------------------------------------------------------------------------

local function lease(valid)
    if not flight then return false end
    local now = os.time()
    if valid and flight.leaseAt and clock - flight.leaseAt < LEASE_PERIOD then return true end
    local text = encode({requestId = flight.requestId, valid = valid, updated = now * 1000,
        playbackStartedAt = flight.playbackAt and flight.playbackAt * 1000 or nil})
    local written = text ~= nil and writeFile('reaction-lease.json', text)
    if written then flight.leaseAt = clock end
    return written
end

local function release(reason, stop)
    local current = flight
    if not current then return end
    pcall(lease, false)
    if stop and host and host.drop then pcall(host.drop, current.requestId, reason, current.entity) end
    flight = nil
    current.speaker.lastAt = clock
    lastSpeechEndAt = clock
    local addon = current.speaker.addon
    if current.stage == 'playing' or current.stage == 'captions' then addon.lastRemarkAt = clock
    elseif current.episode == addon.episode and current.episodeStart == addon.episode.start and addon.episode.count > 0 then
        addon.episode.count = addon.episode.count - 1   -- nothing was heard: the budget is not spent
    end
    log('Remark released: ' .. current.speaker.key .. ' event=' .. current.event .. ' reason=' .. tostring(reason))
    emitTo(current.speaker.addon, 'remarkFinished', {speaker = current.speaker.id, event = current.event,
        reason = reason, spoken = current.stage == 'playing' or current.stage == 'captions'})
end

local function drop(entry, reason)
    emitTo(entry.speaker.addon, 'remarkDropped', {speaker = entry.speaker.id, event = entry.event.event, reason = reason})
end

-- ---- How often an add-on speaks -------------------------------------------------------------------------------------------

local function choice(list, value, default)
    return list[type(value) == 'number' and list[value] and value or default]
end
local function gapOf(addon) return choice(GAPS, addon.values and addon.values.remarkGap, GAP_DEFAULT) end
local function capOf(addon) return choice(CAPS, addon.values and addon.values.remarkCap, CAP_DEFAULT) end

local function episodeOf(addon)
    local episode = addon.episode
    if not watch.combat and clock - episode.start >= EPISODE_IDLE then episode.start, episode.count = clock, 0 end
    return episode
end

-- nil when the add-on may make a remark of this priority now, else why not.
local function rateBlocked(addon, priority)
    if addon.quietUntil and clock < addon.quietUntil then return 'no-provider' end
    if addon.paceUntil and clock < addon.paceUntil then return 'addon-gap' end
    local cap, episode = capOf(addon), episodeOf(addon)
    if episode.count >= cap then return 'episode-budget' end
    if episode.count == cap - 1 and priority < 4 then return 'episode-budget' end
    local gap = priority >= 5 and gapOf(addon) / 2 or gapOf(addon)
    if addon.lastRemarkAt and clock - addon.lastRemarkAt < gap then return 'addon-gap' end
    return nil
end

-- ---- Registration ----------------------------------------------------------------------------------------------------------

local Handle = {}
Handle.__index = Handle

local function guard(name, fn)
    return function(...)
        local results = {pcall(fn, ...)}
        if results[1] then return select(2, (table.unpack or unpack)(results)) end
        log(name .. ' failed: ' .. tostring(results[2]))
        return nil, 'internal error: ' .. tostring(results[2])
    end
end

local function loadSettings()
    if settingsValues then return end
    settingsValues = {}
    local doc = decode(readFile('addon-settings.json'))
    if type(doc) == 'table' and doc.version == 1 and type(doc.addons) == 'table' then
        for id, values in pairs(doc.addons) do
            if type(id) == 'string' and type(values) == 'table' then settingsValues[id] = values end
        end
    end
end

local api = {version = M.API_VERSION, major = M.API_MAJOR, minor = M.API_MINOR}

--- api.compatible('1.0') -> true when this main mod serves an add-on written for that API version.
function api.compatible(required)
    local major, minor = parseVersion(required)
    return major ~= nil and major == M.API_MAJOR and minor <= M.API_MINOR
end

--- api.register({id, name, version, requires}) -> handle, or nil and the reason.
api.register = guard('register', function(def)
    if type(def) ~= 'table' then return nil, 'register needs a table' end
    local id, name = def.id, trim(def.name, 60)
    if type(id) ~= 'string' or #id < 2 or #id > 24 or not id:match('^[a-z][a-z0-9%-]*$') then return nil, 'invalid id' end
    if not name then return nil, 'name is required' end
    if not api.compatible(def.requires) then
        local wanted = type(def.requires) == 'string' and def.requires or '?'
        notify(name .. ' needs a newer Cyberpunk Convai (add-on API ' .. wanted .. '; this version has '
            .. M.API_VERSION .. '). Update Cyberpunk Convai.')
        M.live = true
        log('Add-on ' .. id .. ' refused: needs API ' .. wanted)
        return nil, 'incompatible: needs add-on API ' .. wanted .. ', this main mod has ' .. M.API_VERSION
    end
    loadSettings()
    local previous = addons[id]
    if previous then
        for key, speaker in pairs(speakers) do if speaker.addon == previous then speakers[key] = nil end end
    else order[#order + 1] = id end
    local addon = {id = id, name = name, version = type(def.version) == 'string' and def.version:sub(1, 32) or '?',
        enabled = true, handlers = {}, speakers = {}, companion = {}, companionOrder = {}, state = nil,
        settingsDef = nil, values = settingsValues[id] or {}, events = {}, episode = {start = clock, count = 0},
        lastRemarkAt = nil, quietUntil = nil, memories = {}, warm = nil}
    if not GAPS[addon.values.remarkGap] then addon.values.remarkGap = GAP_DEFAULT end
    if not CAPS[addon.values.remarkCap] then addon.values.remarkCap = CAP_DEFAULT end
    addons[id] = addon
    M.live = true
    if host and host.watchParty then pcall(host.watchParty, function() partyDirty = true end) end
    log('Add-on registered: ' .. id .. ' ' .. addon.version)
    return setmetatable({id = id, record = addon}, Handle)
end)

M.public = api

local function speakerOf(handle, id)
    local addon = type(handle) == 'table' and handle.record
    if not addon or addons[addon.id] ~= addon then return nil end
    return addon.speakers[id]
end

--- handle:speaker({id, name, anchor, available, talk, group, minGap, sceneTiers, talkPriority}) -> profileKey
Handle.speaker = guard('speaker', function(self, def)
    local addon = self and self.record
    if not addon or addons[addon.id] ~= addon then return nil, 'unknown add-on' end
    if type(def) ~= 'table' or type(def.id) ~= 'string' or #def.id > 24 or not def.id:match('^[a-z][a-z0-9%-]*$') then
        return nil, 'invalid speaker id'
    end
    local name = trim(def.name, 60)
    if not name then return nil, 'speaker name is required' end
    local anchor = def.anchor or 'player'
    if anchor ~= 'player' and anchor ~= 'vehicle' and type(anchor) ~= 'function' then return nil, 'anchor must be player, vehicle or a function' end
    if def.available ~= nil and type(def.available) ~= 'function' then return nil, 'available must be a function' end
    local tiers = {1}
    if type(def.sceneTiers) == 'table' then
        tiers = {}
        for _, tier in ipairs(def.sceneTiers) do if type(tier) == 'number' and tier >= 1 and tier <= 5 then tiers[#tiers + 1] = tier end end
        if #tiers == 0 then tiers = {1} end
    end
    local key = 'addon-' .. addon.id .. '-' .. def.id
    local speaker = {addon = addon, id = def.id, key = key, name = name, anchor = anchor, available = def.available,
        talk = def.talk ~= false, group = def.group == true, minGap = number(def.minGap, 2, 600, 8),
        talkPriority = number(def.talkPriority, 0, 100, 0), sceneTiers = tiers,
        contexts = {}, contextOrder = {}, contextTiers = {}, lastAt = nil, events = {}, warmedAt = nil, mode = nil}
    addon.speakers[def.id] = speaker
    speakers[key] = speaker
    if host and host.registerProfile then pcall(host.registerProfile, key) end
    return key
end)

--- handle:remark(speakerId, {event, text, facts, priority, ttl, maxWords, interrupt, cooldown}) -> true, or false and the reason
Handle.remark = guard('remark', function(self, speakerId, event)
    local speaker = speakerOf(self, speakerId)
    if not speaker then return false, 'unknown speaker' end
    if type(event) ~= 'table' or type(event.event) ~= 'string' or #event.event > 48 or not event.event:match('^[%w_%.:%-]+$') then
        return false, 'event name is required (letters, digits, _ . : -)'
    end
    if not speaker.addon.enabled then return false, 'add-on disabled' end
    local facts = nil
    if event.facts ~= nil then
        if type(event.facts) ~= 'table' then return false, 'facts must be a table' end
        local text = encode(event.facts)
        if not text or #text > LIMITS.facts then return false, 'facts are too large' end
        facts = event.facts
    end
    if speaker.lastAt and clock - speaker.lastAt < speaker.minGap then return false, 'speaker-cooldown' end
    local blocked = rateBlocked(speaker.addon, math.floor(number(event.priority, 1, 5, 2)))
    if blocked then return false, blocked end
    local cooldown = number(event.cooldown, 0, 3600, 0)
    if cooldown > 0 and speaker.events[event.event] and clock - speaker.events[event.event] < cooldown then return false, 'event-cooldown' end
    local entry = {speaker = speaker, at = clock, event = {event = event.event, text = trim(event.text, LIMITS.eventText), facts = facts,
        priority = math.floor(number(event.priority, 1, 5, 2)), maxWords = math.floor(number(event.maxWords, 3, 60, 14)),
        interrupt = event.interrupt == true, cooldown = cooldown, stock = event.stock == true}}
    entry.ttl = number(event.ttl, 1, 30, DEFAULT_TTL)
    entry.expires = clock + entry.ttl
    -- One waiting remark per speaker and event name: the newer facts replace the older ones.
    for index = #queue, 1, -1 do
        local other = queue[index]
        if other.speaker == speaker and other.event.event == entry.event.event then table.remove(queue, index) end
    end
    -- While a remark is being written or spoken, at most one waits behind it (the strongest; a tie goes to the newer moment).
    if flight and #queue > 0 then
        for _, other in ipairs(queue) do if other.event.priority > entry.event.priority then return false, 'busy' end end
        for index = #queue, 1, -1 do local other = table.remove(queue, index); drop(other, 'replaced') end
    end
    if #queue >= LIMITS.queue then
        local weakest, at = nil, nil
        for index, other in ipairs(queue) do
            if not weakest or other.event.priority < weakest.event.priority
                or (other.event.priority == weakest.event.priority and other.at < weakest.at) then weakest, at = other, index end
        end
        if weakest.event.priority >= entry.event.priority then return false, 'queue-full' end
        table.remove(queue, at); drop(weakest, 'replaced')
    end
    queue[#queue + 1] = entry
    return true
end)

--- handle:setContext(speakerId, key, text|nil, tier) : a block sent with every turn of that speaker until cleared.
Handle.setContext = guard('setContext', function(self, speakerId, key, text, tier)
    local speaker = speakerOf(self, speakerId)
    if not speaker then return false, 'unknown speaker' end
    if type(key) ~= 'string' or #key > 40 or not key:match('^[%w_%.:%-]+$') then return false, 'invalid key' end
    text = trim(text, LIMITS.blockText)
    if not text then
        speaker.contexts[key], speaker.contextTiers[key] = nil, nil
        for index = #speaker.contextOrder, 1, -1 do if speaker.contextOrder[index] == key then table.remove(speaker.contextOrder, index) end end
        stockTouch(speaker)
        return true
    end
    if not speaker.contexts[key] then
        if #speaker.contextOrder >= LIMITS.blocks then return false, 'too many context blocks' end
        speaker.contextOrder[#speaker.contextOrder + 1] = key
    end
    speaker.contexts[key] = text
    speaker.contextTiers[key] = (tier == 'volatile' or tier == 'notes') and tier or 'world'
    stockTouch(speaker)
    return true
end)

--- handle:setCompanionContext(key, text|nil) : a block in every companion's prompt until cleared ("you are riding in a cab").
Handle.setCompanionContext = guard('setCompanionContext', function(self, key, text)
    local addon = self and self.record
    if not addon or addons[addon.id] ~= addon then return false, 'unknown add-on' end
    if type(key) ~= 'string' or #key > 40 or not key:match('^[%w_%.:%-]+$') then return false, 'invalid key' end
    text = trim(text, LIMITS.companionText)
    if not text then
        if addon.companion[key] == nil then return true end
        addon.companion[key] = nil
        for index = #addon.companionOrder, 1, -1 do if addon.companionOrder[index] == key then table.remove(addon.companionOrder, index) end end
    else
        if addon.companion[key] == text then return true end
        if not addon.companion[key] then
            if #addon.companionOrder >= LIMITS.companionBlocks then return false, 'too many companion blocks' end
            addon.companionOrder[#addon.companionOrder + 1] = key
        end
        addon.companion[key] = text
    end
    stateDirty = true
    return true
end)

--- handle:setState(table|nil) : plain data the add-on's bridge module receives as `state`.
Handle.setState = guard('setState', function(self, value)
    local addon = self and self.record
    if not addon or addons[addon.id] ~= addon then return false, 'unknown add-on' end
    if value ~= nil and type(value) ~= 'table' then return false, 'state must be a table or nil' end
    local text = value and encode(value)
    if value and (not text or #text > LIMITS.facts) then return false, 'state is too large' end
    addon.state = value
    stateDirty = true
    return true
end)

--- handle:on(eventName, function(payload) end)
Handle.on = guard('on', function(self, name, fn)
    local addon = self and self.record
    if not addon or addons[addon.id] ~= addon then return false, 'unknown add-on' end
    if not EVENTS[name] then return false, 'unknown event ' .. tostring(name) end
    if type(fn) ~= 'function' then return false, 'handler must be a function' end
    addon.handlers[name] = addon.handlers[name] or {}
    table.insert(addon.handlers[name], {fn = fn, failures = 0})
    if (name == 'companionJoined' or name == 'companionLeft') then partyDirty = true end
    return true
end)

--- handle:settings({title, description, items = {{id, label, kind = 'bool'|'select', default, description, elements}}})
Handle.settings = guard('settings', function(self, section)
    local addon = self and self.record
    if not addon or addons[addon.id] ~= addon then return false, 'unknown add-on' end
    if type(section) ~= 'table' or type(section.items) ~= 'table' then return false, 'settings need items' end
    local title = trim(section.title, 60) or addon.name
    local items = {}
    for _, item in ipairs(section.items) do
        if #items >= LIMITS.settings then break end
        if type(item) ~= 'table' or type(item.id) ~= 'string' or #item.id > 32 or not item.id:match('^[%w_]+$') then return false, 'invalid setting id' end
        if item.id == 'remarkGap' or item.id == 'remarkCap' or item.id == 'remarkGapChosen' or item.id == 'remarkRate' then
            return false, item.id .. ' is a built-in setting'
        end
        local label = trim(item.label, 80)
        if not label then return false, 'setting ' .. item.id .. ' needs a label' end
        local entry = {id = item.id, label = label, kind = item.kind, description = trim(item.description, 600) or ''}
        if item.kind == 'bool' then
            entry.default = item.default == true
        elseif item.kind == 'select' then
            if type(item.elements) ~= 'table' or #item.elements < 2 or #item.elements > 12 then return false, 'setting ' .. item.id .. ' needs 2 to 12 elements' end
            entry.elements = {}
            for index, element in ipairs(item.elements) do
                local text = trim(element, 60)
                if not text then return false, 'setting ' .. item.id .. ' has an empty element' end
                entry.elements[index] = text
            end
            entry.default = math.floor(number(item.default, 1, #entry.elements, 1))
        else return false, 'setting kind must be bool or select' end
        items[#items + 1] = entry
    end
    addon.settingsDef = {title = title, description = trim(section.description, 300) or '', items = items}
    for _, item in ipairs(items) do
        local value = addon.values[item.id]
        local valid = (item.kind == 'bool' and type(value) == 'boolean')
            or (item.kind == 'select' and type(value) == 'number' and value >= 1 and value <= #item.elements and value % 1 == 0)
        if not valid then addon.values[item.id] = item.default end
    end
    return true
end)

--- handle:setting(id) -> the current value (a boolean, or the 1-based index of a select).
function Handle.setting(self, id)
    local addon = self and self.record
    return addon and addon.values and addon.values[id]
end

--- handle:setEnabled(boolean): a disabled add-on is never offered for talk and makes no remarks (its settings still show).
Handle.setEnabled = guard('setEnabled', function(self, value)
    local addon = self and self.record
    if not addon or addons[addon.id] ~= addon then return false, 'unknown add-on' end
    addon.enabled = value ~= false
    if not addon.enabled then
        for index = #queue, 1, -1 do if queue[index].speaker.addon == addon then table.remove(queue, index) end end
        if flight and flight.speaker.addon == addon then release('add-on-disabled', true) end
    end
    return true
end)

--- handle:notify(text) : one on-screen notice through the main mod's notice system (repeats within 10 s are dropped).
function Handle.notify(self, text)
    local addon = self and self.record
    text = trim(text, 200)
    if not addon or not text then return false end
    notify(text)
    return true
end

--- handle:cancel(speakerId) : drops that speaker's waiting remarks and stops its remark in flight.
Handle.cancel = guard('cancel', function(self, speakerId)
    local speaker = speakerOf(self, speakerId)
    if not speaker then return false, 'unknown speaker' end
    for index = #queue, 1, -1 do if queue[index].speaker == speaker then table.remove(queue, index) end end
    if flight and flight.speaker == speaker then release('cancelled', true) end
    return true
end)

--- handle:prepare(speakerId) : warms the speaker's connection and voice now (call when it becomes available).
Handle.prepare = guard('prepare', function(self, speakerId)
    local speaker = speakerOf(self, speakerId)
    if not speaker or not host then return false, 'unknown speaker' end
    if speaker.warmedAt and clock - speaker.warmedAt < 20 then return true end
    local player = host.player and host.player()
    if not speakerAvailable(speaker, player) then return false, 'speaker-unavailable' end
    local _, entity = resolveAnchor(speaker, player)
    if not entity then return false, 'anchor-unavailable' end
    speaker.warmedAt = clock
    -- The bridge warms the speaker's text route (a Mistral connection, or its prompt in the local AI) when it sees the stamp.
    speaker.addon.warm = {speaker = speaker.id, at = os.time() * 1000 + math.floor(clock * 10) % 1000}
    stateDirty = true
    return true
end)

--- handle:setMode(speakerId, modeId) : switches the speaker's personality mode (the modes its convai-addon.json defines).
Handle.setMode = guard('setMode', function(self, speakerId, mode)
    local speaker = speakerOf(self, speakerId)
    if not speaker then return false, 'unknown speaker' end
    if type(mode) ~= 'string' or #mode > 24 or not mode:match(MODE_ID) then return false, 'invalid mode id' end
    if speaker.mode ~= mode then speaker.mode = mode; stateDirty = true end
    return true
end)

--- handle:remember(speakerId, text) : a memory the speaker can call back to later ("the cab ride through the Badlands storm").
Handle.remember = guard('remember', function(self, speakerId, text)
    local speaker = speakerOf(self, speakerId)
    if not speaker then return false, 'unknown speaker' end
    text = trim(text, 300)
    if not text then return false, 'memory text is required' end
    local list = speaker.addon.memories
    for _, item in ipairs(list) do if item.speaker == speaker.id and item.text == text then return true end end
    list[#list + 1] = {speaker = speaker.id, text = text, at = os.time() * 1000}
    while #list > 12 do table.remove(list, 1) end
    stateDirty = true
    return true
end)

-- ---- Stock: lines the bridge writes ahead of a moment (docs/ADDON_API.md, "Stock") ------------------------------------------
-- A fresh remark costs a model call and the voice; a prepared line costs only the voice. The add-on describes the line it will want
-- ("V is about to kill another enemy"); the bridge keeps a few ready, and handle:remark(..., {stock = true}) uses one when it can.
-- Limits shared with the bridge (bridge/addons.mjs ADDON_LIMITS stock*).
local STOCK = {keys = 12, text = 600, slots = 8, slotName = 48, blocks = 4, blocksText = 3000}

local function sameValue(a, b)
    if type(a) ~= type(b) then return false end
    if type(a) ~= 'table' then return a == b end
    for key, value in pairs(a) do if not sameValue(value, b[key]) then return false end end
    for key in pairs(b) do if a[key] == nil then return false end end
    return true
end

--- handle:stock(speakerId, key, {text, facts, maxWords, want, ttl, slots} | nil) -> true, or false and the reason. nil clears the key.
Handle.stock = guard('stock', function(self, speakerId, key, spec)
    local speaker = speakerOf(self, speakerId)
    if not speaker then return false, 'unknown speaker' end
    if type(key) ~= 'string' or #key > 48 or not key:match('^[%w_%.:%-]+$') then return false, 'stock key is required (letters, digits, _ . : -)' end
    speaker.stock, speaker.stockOrder = speaker.stock or {}, speaker.stockOrder or {}
    if spec == nil then
        if speaker.stock[key] then
            speaker.stock[key] = nil
            for index = #speaker.stockOrder, 1, -1 do if speaker.stockOrder[index] == key then table.remove(speaker.stockOrder, index) end end
            stateDirty = true
        end
        return true
    end
    if type(spec) ~= 'table' then return false, 'stock spec must be a table or nil' end
    if not speaker.addon.enabled then return false, 'add-on disabled' end
    local text = trim(spec.text, STOCK.text)
    if not text then return false, 'stock text is required' end
    local facts = nil
    if spec.facts ~= nil then
        if type(spec.facts) ~= 'table' then return false, 'facts must be a table' end
        local encoded = encode(spec.facts)
        if not encoded or #encoded > LIMITS.facts then return false, 'facts are too large' end
        facts = spec.facts
    end
    local slots = {}
    if spec.slots ~= nil then
        local count = 0
        if type(spec.slots) ~= 'table' then return false, 'slots must be a list of names' end
        for _ in pairs(spec.slots) do count = count + 1 end
        if count ~= #spec.slots or count > STOCK.slots then return false, 'slots must be a list of at most ' .. STOCK.slots .. ' names' end
        local seen = {}
        for _, name in ipairs(spec.slots) do
            if type(name) ~= 'string' or #name > STOCK.slotName or not name:match('^[%w_%.]+$') then return false, 'invalid slot name (letters, digits, _ .)' end
            if not seen[name] then seen[name] = true; slots[#slots + 1] = name end
        end
    end
    local fresh = {key = key, text = text, facts = facts, maxWords = math.floor(number(spec.maxWords, 3, 60, 10)),
        want = math.floor(number(spec.want, 1, 4, 2)), ttl = math.floor(number(spec.ttl, 10, 300, 90)), slots = slots}
    local old = speaker.stock[key]
    if old then
        local same = true
        for _, field in ipairs({'text', 'facts', 'maxWords', 'want', 'ttl', 'slots'}) do
            if not sameValue(old[field], fresh[field]) then same = false; break end
        end
        if same then return true end
    elseif #speaker.stockOrder >= STOCK.keys then
        return false, 'too many stock entries (at most ' .. STOCK.keys .. ' per speaker)'
    else
        speaker.stockOrder[#speaker.stockOrder + 1] = key
    end
    -- The revision only grows: the bridge drops the lines it wrote for an earlier one, also after the key was cleared and set again.
    speaker.stockRev = (speaker.stockRev or 0) + 1
    fresh.rev = speaker.stockRev
    speaker.stock[key] = fresh
    stateDirty = true
    return true
end)

-- The stock rows of an add-on for runtime/addon-state.json: {speaker, key, text, facts, maxWords, want, ttl, slots, rev, blocks}.
-- `blocks` is a copy of the speaker's context blocks at write time (at most 4, 3000 characters), so the bridge writes in its voice.
local function stockRows(addon)
    local rows, ids = {}, {}
    for id, speaker in pairs(addon.speakers) do if speaker.stockOrder and #speaker.stockOrder > 0 then ids[#ids + 1] = id end end
    table.sort(ids)
    for _, id in ipairs(ids) do
        local speaker = addon.speakers[id]
        local blocks, total = {}, 0
        for _, block in ipairs(speakerBlocks(speaker)) do
            if #blocks >= STOCK.blocks then break end
            if total + #block.text <= STOCK.blocksText then total = total + #block.text; blocks[#blocks + 1] = block end
        end
        for _, key in ipairs(speaker.stockOrder) do
            local entry = speaker.stock[key]
            rows[#rows + 1] = {speaker = id, key = key, text = entry.text, facts = entry.facts, maxWords = entry.maxWords, want = entry.want,
                ttl = entry.ttl, slots = entry.slots, rev = entry.rev, blocks = blocks}
        end
    end
    return rows
end

-- Forgets every stock request of an add-on (a save load, death or shutdown: the add-on asks again from its new events).
local function clearStock(addon)
    local had = false
    for _, speaker in pairs(addon.speakers) do
        if speaker.stockOrder and #speaker.stockOrder > 0 then had = true end
        speaker.stock, speaker.stockOrder = {}, {}
    end
    return had
end

--- handle:state() -> {worldReady, combat, vehicle, scene, speaking, conversation, remark}
function Handle.state(self)
    local sample = watch.sample or {}
    return {worldReady = watch.worldReady == true, combat = sample.combat == true, vehicle = sample.vehicle == true,
        scene = watch.scene == true, speaking = watch.speaking == true, conversation = watch.conversation == true,
        remark = flight ~= nil and flight.speaker.addon == (self and self.record) and flight.speaker.id or nil}
end

--- handle:native() -> read-only view of the main mod's optional native plugin (all calls guarded; works without it).
function Handle.native(self)
    local function core() return host and host.native and host.native() or nil end
    return {
        present = function() local n = core(); return type(n) == 'table' and n.present == true end,
        use = function(system) local n = core(); if type(n) ~= 'table' or type(n.use) ~= 'function' then return false end
            local ok, value = pcall(n.use, system); return ok and value == true end,
        revision = function(name) local n = core(); if type(n) ~= 'table' or type(n.revision) ~= 'function' then return nil end
            local ok, value = pcall(n.revision, name); return ok and value or nil end,
        status = function() local n = core(); if type(n) ~= 'table' or type(n.status) ~= 'function' then return nil end
            local ok, value = pcall(n.status); return ok and value or nil end,
    }
end

function Handle.log(self, message)
    log((self and self.id or '?') .. ': ' .. tostring(message))
end

-- ---- Calls from init.lua ---------------------------------------------------------------------------------------------------

--- init.lua hands over the functions this file needs (see docs/ADDON_API.md, "Main mod seams").
function M.attach(value)
    host = value
end

local function stateDocument()
    local doc = {version = 1, updated = os.time() * 1000, addons = {}}
    for _, id in ipairs(order) do
        local addon = addons[id]
        local blocks, modes, anyMode = {}, {}, false
        for _, key in ipairs(addon.companionOrder) do blocks[#blocks + 1] = {key = key, text = addon.companion[key]} end
        for speakerId, speaker in pairs(addon.speakers) do if speaker.mode then modes[speakerId] = speaker.mode; anyMode = true end end
        local stock = stockRows(addon)
        if #blocks > 0 or addon.state ~= nil or anyMode or #addon.memories > 0 or addon.warm or #stock > 0 then
            doc.addons[id] = {companionContext = blocks, state = addon.state, modes = anyMode and modes or nil,
                memories = #addon.memories > 0 and addon.memories or nil, warm = addon.warm, stock = #stock > 0 and stock or nil}
        end
    end
    return doc
end

local function writeState(force)
    if not stateDirty and not force then return end
    if not force and clock - stateWrittenAt < .5 then return end
    local text = encode(stateDocument())
    if text and writeFile('addon-state.json', text) then stateDirty, stateWrittenAt = false, clock end
end

local function outputs(player)
    if outputsCache and clock - outputsAt < .5 then return outputsCache end
    outputsAt = clock
    outputsCache = host.outputs and host.outputs(player) or {enabled = true}
    return outputsCache
end

local function deriveEvents(player, state, worldReady)
    local sample = state.sample
    watch.sample, watch.worldReady = sample, worldReady
    local manual = state.active or state.microphone or state.group or state.phone
    watch.conversation = manual == true
    watch.speaking = state.speechId ~= nil or state.captions == true
    if not sessionOpen then sessionOpen = true; emit('sessionStarted', {}) end
    if sample and sample.available then
        local scene = sample.dialogue == true or sample.choices == true or sample.call == true or sample.tier ~= 1
        if sample.combat and watch.combat ~= true then
            -- A fight is one episode: every add-on's remark budget starts again.
            for _, id in ipairs(order) do addons[id].episode = {start = clock, count = 0} end
        end
        if watch.combat ~= nil and sample.combat ~= watch.combat then emit(sample.combat and 'combatStarted' or 'combatEnded', {}) end
        if watch.vehicle ~= nil and sample.vehicle ~= watch.vehicle then
            if sample.vehicle then
                local vehicle, id = nil, nil
                pcall(function() vehicle = player:GetMountedVehicle(); id = vehicle and tostring(vehicle:GetEntityID().hash) or nil end)
                emit('vehicleEntered', {vehicle = vehicle, vehicleId = id})
            else emit('vehicleExited', {}) end
        end
        if watch.scene ~= nil and scene ~= watch.scene then emit(scene and 'sceneStarted' or 'sceneEnded', {}) end
        watch.combat, watch.vehicle, watch.scene = sample.combat == true, sample.vehicle == true, scene
    end
    -- Turns and speech: a request becomes pending, may be heard, and ends when it is neither.
    local turn = watch.turn
    if turn and state.pendingId ~= turn.requestId and state.speechId ~= turn.requestId then
        watch.turn = nil
        emit('turnEnded', turn)
    end
    if state.pendingId and (not watch.turn or watch.turn.requestId ~= state.pendingId) then
        watch.turn = {requestId = state.pendingId, profileKey = state.pendingProfile, reaction = state.pendingReaction,
            addon = speakers[state.pendingProfile or ''] and speakers[state.pendingProfile].addon.id or nil}
        emit('turnStarted', watch.turn)
    end
    if state.speechId ~= watch.speechId then
        if watch.speechId then lastSpeechEndAt = clock; emit('speechEnded', {requestId = watch.speechId}) end
        if state.speechId then emit('speechStarted', {requestId = state.speechId, name = state.speechName}) end
        watch.speechId = state.speechId
    end
    if partyDirty and (subscribed('companionJoined') or subscribed('companionLeft')) and host.partyProfiles then
        partyDirty = false
        local ok, list = pcall(host.partyProfiles)
        if ok and type(list) == 'table' then
            local now = {}
            for _, key in ipairs(list) do now[key] = true end
            if partyKnown then
                for key in pairs(now) do if not partyKnown[key] then emit('companionJoined', {profileKey = key}) end end
                for key in pairs(partyKnown) do if not now[key] then emit('companionLeft', {profileKey = key}) end end
            end
            partyKnown = now
        end
    end
end

local function trackFlight(player, state)
    if not flight then return end
    local id = flight.requestId
    if state.pendingId == id then
        flight.stage = 'pending'
    elseif state.speechId == id then
        if flight.stage ~= 'playing' then
            flight.stage, flight.playbackAt, flight.leaseAt = 'playing', os.time(), nil
            emitTo(flight.speaker.addon, 'remarkStarted', {speaker = flight.speaker.id, event = flight.event})
        end
    elseif flight.stage == 'pending' and state.captions and not state.speechId then
        -- Subtitles only (voice off): the caption this reply showed owns the turn until it ends.
        flight.stage, flight.playbackAt, flight.leaseAt = 'captions', os.time(), nil
        emitTo(flight.speaker.addon, 'remarkStarted', {speaker = flight.speaker.id, event = flight.event})
    elseif flight.stage == 'captions' and state.captions then
        -- still on screen
    else
        release(flight.stage == 'pending' and 'not-delivered' or 'finished', false)
        return
    end
    -- A conversation the player starts, a scene, or the speaker going away ends the remark at once.
    local manual = state.active or state.microphone or state.group or state.phone
    local blocked, why = sceneBlocked(state.sample, flight.speaker)
    if manual then release('manual-priority', true); return end
    if blocked then release(why, true); return end
    if not speakerAvailable(flight.speaker, player) then release('speaker-unavailable', true); return end
    for _, entry in ipairs(queue) do
        if entry.event.interrupt and entry.event.priority > flight.priority then release('interrupted', true); return end
    end
    if not lease(true) then release('lease-write-failed', true) end
end

local function schedule(player, state, worldReady)
    if flight or #queue == 0 then return end
    for index = #queue, 1, -1 do
        local entry = queue[index]
        if clock > entry.expires then table.remove(queue, index); drop(entry, 'expired') end
    end
    if #queue == 0 or not worldReady or not host or not host.submit then return end
    if state.active or state.microphone or state.group or state.phone or state.automatic
        or state.pendingId or state.speechId or state.captions then return end
    if clock - lastSpeechEndAt < GLOBAL_GAP then return end
    if not outputs(player).enabled then return end
    table.sort(queue, function(a, b)
        if a.event.priority ~= b.event.priority then return a.event.priority > b.event.priority end
        return a.at < b.at
    end)
    while #queue > 0 do
        local entry = table.remove(queue, 1)
        local speaker = entry.speaker
        local blocked, why = sceneBlocked(state.sample, speaker)
        local object, entity = nil, nil
        if not blocked and speakerAvailable(speaker, player) then object, entity = resolveAnchor(speaker, player) end
        if blocked then drop(entry, why)
        elseif not entity then drop(entry, 'speaker-unavailable')
        elseif speaker.lastAt and clock - speaker.lastAt < speaker.minGap then drop(entry, 'speaker-cooldown')
        elseif rateBlocked(speaker.addon, entry.event.priority) then drop(entry, rateBlocked(speaker.addon, entry.event.priority))
        else
            local generation = host.nextGeneration()
            local now = os.time()
            local event = entry.event
            local context = {generation = generation, entity = entity, name = speaker.name, bodyType = '',
                profileKey = speaker.key, sentAt = now, voiceOnly = true,
                text = event.text or ('[' .. speaker.addon.name .. '] ' .. event.event),
                reaction = {kind = 'addon', addon = speaker.addon.id, speaker = speaker.id, event = event.event,
                    priority = event.priority, expiresAt = math.floor((now + math.max(1, entry.expires - clock)) * 1000)},
                addon = {id = speaker.addon.id, speaker = speaker.id, event = event.event, text = event.text,
                    facts = event.facts, maxWords = event.maxWords, mode = speaker.mode, blocks = speakerBlocks(speaker),
                    stock = event.stock or nil}}
            context.requestId = tostring(now) .. '-' .. tostring(generation) .. '-' .. entity
            local episode = episodeOf(speaker.addon)
            flight = {requestId = context.requestId, speaker = speaker, event = event.event, priority = event.priority,
                stage = 'pending', entity = entity, episode = episode, episodeStart = episode.start, at = entry.at, ttl = entry.ttl or DEFAULT_TTL}
            local ok, sent = false, false
            if lease(true) then ok, sent = pcall(host.submit, context, object) end
            if ok and sent then
                episode.count = episode.count + 1
                -- No build-up behind the remark in flight: only the strongest waiting one is kept (the queue is sorted, best first).
                while #queue > 1 do drop(table.remove(queue), 'replaced') end
                if event.cooldown > 0 then speaker.events[event.event] = clock end
                log('Remark: ' .. speaker.key .. ' event=' .. event.event .. ' priority=' .. event.priority)
            else
                pcall(lease, false)
                flight = nil
                drop(entry, 'request-write-failed')
            end
            return
        end
    end
end

-- What the bridge found when it started (bridge/addons.mjs publishStatus): an add-on folder it could not load is told to the
-- player once. One file read per game start, and only with an add-on registered.
local function readBridgeStatus()
    bridgeStatusRead = true
    local doc = decode(readFile('addons-status.json'))
    if type(doc) ~= 'table' or doc.version ~= 1 or type(doc.addons) ~= 'table' then return end
    for _, entry in ipairs(doc.addons) do
        if type(entry) == 'table' and entry.status ~= 'ready' and type(entry.reason) == 'string' then
            local name = trim(entry.name, 60) or trim(entry.folder, 60) or 'An add-on'
            if entry.status == 'incompatible' then
                notify(name .. ' needs a newer Cyberpunk Convai (' .. trim(entry.reason, 160) .. '). Update Cyberpunk Convai.')
            else notify(name .. ' could not load: ' .. trim(entry.reason, 160)) end
        end
    end
end

--- Every 0.1 s from init.lua's onUpdate while live (and only then).
function M.tick(player, elapsed, worldReady)
    clock = clock + (tonumber(elapsed) or 0)
    if not host then return end
    if worldReady and not bridgeStatusRead then pcall(readBridgeStatus) end
    if worldReady and player and #pendingNotices > 0 and host.notify then
        for _, text in ipairs(pendingNotices) do pcall(host.notify, player, text) end
        pendingNotices = {}
    end
    if #order == 0 then return end
    if #settingEvents > 0 then
        local events = settingEvents
        settingEvents = {}
        for _, change in ipairs(events) do emitTo(change.addon, 'settingChanged', {id = change.id, value = change.value}) end
    end
    local state = host.state()
    deriveEvents(player, state, worldReady)
    trackFlight(player, state)
    schedule(player, state, worldReady)
    writeState(false)
end

--- The reply of an add-on remark arrived: may it play now? (init.lua reactionCanDeliver)
function M.canDeliver(context, player)
    if not flight or type(context) ~= 'table' or flight.requestId ~= context.requestId then return false end
    -- The moment has passed (the reply took too long): a late remark is worse than none.
    if flight.at and clock - flight.at > flight.ttl then release('stale', true); return false end
    local sample = host and host.sample and host.sample(player) or watch.sample
    local blocked, why = sceneBlocked(sample, flight.speaker)
    if blocked then release(why, true); return false end
    if not speakerAvailable(flight.speaker, player) then release('speaker-unavailable', true); return false end
    local _, entity = resolveAnchor(flight.speaker, player)
    if entity ~= context.entity then release('anchor-changed', true); return false end
    return true
end

--- Speakers the talk keys may address now: [{npc, entity, name, bodyType, profileKey, voiceOnly}], best first.
function M.talkCandidates(player, groupMode)
    local list = {}
    if #order == 0 then return list end
    for _, id in ipairs(order) do
        local addon = addons[id]
        for _, speaker in pairs(addon.speakers) do
            if (groupMode and speaker.group or (not groupMode and speaker.talk)) and speakerAvailable(speaker, player) then
                local object, entity = resolveAnchor(speaker, player)
                if entity then
                    list[#list + 1] = {npc = object, entity = entity, name = speaker.name, bodyType = '',
                        profileKey = speaker.key, voiceOnly = true, distance = 0, priority = speaker.talkPriority}
                end
            end
        end
    end
    table.sort(list, function(a, b)
        if a.priority ~= b.priority then return a.priority > b.priority end
        return a.profileKey < b.profileKey
    end)
    return list
end

--- A group round participant that is an add-on speaker: is it still there?
function M.participantLive(person, player)
    local speaker = type(person) == 'table' and speakers[person.profileKey]
    if not speaker or not speakerAvailable(speaker, player) then return false end
    local _, entity = resolveAnchor(speaker, player)
    return entity ~= nil and entity == person.entity
end

--- Adds the speaker's context blocks to an add-on speaker's request (any turn: typed, spoken, group or a remark).
function M.decorate(context)
    local speaker = type(context) == 'table' and speakers[context.profileKey]
    if not speaker then return end
    if type(context.addon) ~= 'table' then context.addon = {id = speaker.addon.id, speaker = speaker.id} end
    context.addon.blocks = speakerBlocks(speaker)
    context.addon.mode = speaker.mode
end

function M.isSpeaker(profileKey) return speakers[profileKey] ~= nil end

--- The bridge refused an add-on speaker's turn (init.lua, reply error branch):
---   addon-provider   neither Mistral nor the local AI is set up: one notice, and the add-on's remarks pause for two minutes
---   addon-duplicate  the remark repeated a recent line: nothing is shown (the remark is released as not heard)
function M.replyError(context, reply)
    local speaker = type(context) == 'table' and speakers[context.profileKey]
    if not speaker or type(reply) ~= 'table' then return end
    if reply.errorCode == 'addon-provider' then
        local addon = speaker.addon
        addon.quietUntil = clock + PROVIDER_QUIET
        -- Once per game session for remarks; a message V typed is always answered with it.
        if not context.reaction or not addon.providerNoticeShown then
            addon.providerNoticeShown = true
            notify(trim(reply.error, 200) or (addon.name .. ' needs a free Mistral key or the Local AI pack.'))
        end
    elseif reply.errorCode == 'addon-pace' then
        -- The local AI is spacing this add-on's remarks to keep the GPU free for the game: wait before the next one.
        speaker.addon.paceUntil = clock + number(reply.retryAfter, 1, 60, 10)
    end
end

-- ---- Settings (mod/mcm.lua) ----------------------------------------------------------------------------------------------

--- One section per add-on with settings, in registration order.
function M.settingsSections()
    local sections = {}
    for _, id in ipairs(order) do
        local addon = addons[id]
        local def = addon.settingsDef
        local items = {}
        if next(addon.speakers) ~= nil then
            local gaps, caps = {}, {}
            for index, seconds in ipairs(GAPS) do gaps[index] = seconds .. ' s' end
            for index, count in ipairs(CAPS) do caps[index] = count == math.huge and 'No limit' or tostring(count) end
            items[1] = {mcmId = 'addon:' .. id .. ':remarkGap', label = 'Time between remarks', kind = 'select', elements = gaps,
                value = addon.values.remarkGap, default = GAP_DEFAULT,
                description = 'The shortest quiet time between two remarks of ' .. addon.name .. ', counted from the end of the last one. '
                    .. 'The biggest moments (a near death, the end of a fight) need only half of it. While its text comes from the Local AI '
                    .. 'and you keep the default, ' .. addon.name .. ' waits about 20 seconds between remarks to keep the graphics card free for the game.'}
            items[2] = {mcmId = 'addon:' .. id .. ':remarkCap', label = 'Most remarks per fight', kind = 'select', elements = caps,
                value = addon.values.remarkCap, default = CAP_DEFAULT,
                description = 'How many remarks ' .. addon.name .. ' may make in one fight (outside combat: in five minutes). '
                    .. 'The last one is kept for a big moment.'}
        end
        if #items > 0 or (def and #def.items > 0) then
            for _, item in ipairs(def and def.items or {}) do
                items[#items + 1] = {mcmId = 'addon:' .. id .. ':' .. item.id, label = item.label, kind = item.kind,
                    description = item.description, value = addon.values[item.id], default = item.default, elements = item.elements}
            end
            sections[#sections + 1] = {id = 'addon-' .. id, title = def and def.title or addon.name, description = def and def.description or '', items = items}
        end
    end
    return sections
end

local function settingFor(mcmId)
    if type(mcmId) ~= 'string' then return nil end
    local id, key = mcmId:match('^addon:([%w%-]+):([%w_]+)$')
    local addon = id and addons[id]
    if not addon then return nil end
    if key == 'remarkGap' and next(addon.speakers) ~= nil then return addon, {id = 'remarkGap', kind = 'select', elements = GAPS} end
    if key == 'remarkCap' and next(addon.speakers) ~= nil then return addon, {id = 'remarkCap', kind = 'select', elements = CAPS} end
    if not addon.settingsDef then return nil end
    for _, item in ipairs(addon.settingsDef.items) do if item.id == key then return addon, item end end
    return nil
end

--- Checks one MCM change and holds it until the main Apply succeeds.
function M.stageSetting(mcmId, value)
    local addon, item = settingFor(mcmId)
    if not addon then return false, 'That add-on setting is no longer available.' end
    if item.kind == 'bool' and type(value) ~= 'boolean' then return false, 'This setting must be on or off.' end
    if item.kind == 'select' and (type(value) ~= 'number' or value % 1 ~= 0 or value < 1 or value > #item.elements) then
        return false, 'Choose one of the listed options.'
    end
    staged = staged or {}
    staged[#staged + 1] = {addon = addon, id = item.id, value = value}
    return true
end

function M.discardSettings() staged = nil end

--- Saves the held changes (runtime/addon-settings.json) and tells each add-on.
function M.commitSettings()
    local changes = staged
    staged = nil
    if not changes or #changes == 0 then return true end
    for _, change in ipairs(changes) do
        change.addon.values[change.id] = change.value
        -- A gap the player picked is kept as it is on every provider (the Local AI's longer default applies only to the default).
        if change.id == 'remarkGap' then change.addon.values.remarkGapChosen = true end
    end
    local doc = {version = 1, addons = {}}
    for _, id in ipairs(order) do doc.addons[id] = addons[id].values end
    for id, values in pairs(settingsValues or {}) do if not addons[id] then doc.addons[id] = values end end
    local text = encode(doc)
    local saved = text ~= nil and writeFile('addon-settings.json', text)
    for _, change in ipairs(changes) do settingEvents[#settingEvents + 1] = change end
    return saved
end

--- Part of the settings page signature, so the page is drawn again when an add-on's settings change.
function M.signature()
    local parts = {}
    for _, section in ipairs(M.settingsSections()) do
        for _, item in ipairs(section.items) do parts[#parts + 1] = item.mcmId .. '=' .. tostring(item.value) end
    end
    return table.concat(parts, ',')
end

-- ---- Session lifecycle ---------------------------------------------------------------------------------------------------

--- A save load, death, world teardown or CET shutdown: forget every native reference and what the game state was. Never calls
--- a native function (the world may already be gone). Companion context is cleared: an add-on sets it again from new events.
function M.reset(reason)
    if not M.live then return end
    if flight then pcall(lease, false) end
    flight, queue = nil, {}
    watch, partyKnown, partyDirty = {}, nil, true
    outputsCache = nil
    local had = false
    for _, id in ipairs(order) do
        local addon = addons[id]
        local hadStock = clearStock(addon)
        if #addon.companionOrder > 0 or addon.state ~= nil or hadStock then had = true end
        addon.companion, addon.companionOrder, addon.state = {}, {}, nil
        addon.episode, addon.lastRemarkAt, addon.quietUntil, addon.paceUntil = {start = clock, count = 0}, nil, nil, nil
    end
    if had then writeState(true) end
    if sessionOpen then sessionOpen = false; emit('sessionEnded', {reason = reason}) end
end

-- Tests only: the clock and internal tables.
M._test = {clock = function() return clock end, queue = function() return queue end, flight = function() return flight end,
    speakers = speakers, addons = addons}

return M
