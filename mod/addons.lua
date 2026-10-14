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
-- has passed (about 3 s) is dropped, unless it asked for patience (2026-10-14): such a remark waits out a game scene or game dialogue line
-- and goes a short gap after it (see "Patience" in docs/ADDON_API.md). Add-on speakers' text comes only from Mistral or the local AI.
--
-- An add-on may also replace the game's own lines of its character (2026-10-14, "Replacing the game's own lines" in docs/ADDON_API.md):
-- handle:replaceGameLines declares which subtitle lines are its character's; while the player's "Replace the game's own lines" is on,
-- mod/game-dialogue.lua (from the subtitle hooks it already has, never per frame) keeps those lines off the screen and stops their voice
-- where a Wwise event is known. The scene itself is never touched. "Mark our lines" tags the add-on speaker's own subtitles instead.
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
local lineRulesDeclared = false      -- some add-on declared a replaceGameLines rule (mod/game-dialogue.lua asks, once per game line)
local CAPTION_TAG = ' (AI)'          -- what "Mark our lines" adds after the speaker's name in its subtitles
local heldRequest, menuRequest = nil, nil   -- the remark speech.lua keeps paused (hold) / lets play while a menu is open (menus)
local unwatchFaces = {}              -- screen-face rigs a reset left watched: unwatched on the next tick unless the add-on watches again

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
-- The voice stop of a muted game line is sent again at these seconds after the line was seen (M.mutedLine): a scene voice can start a
-- moment after its subtitle line, and a Stop that came first finds nothing to stop. At most `max` lines are tracked at once.
local STOP_REPEAT = {at = {0.3, 0.8, 1.6}, max = 6, pending = {}}
function STOP_REPEAT.run()
    local pending, index = STOP_REPEAT.pending, 1
    while index <= #pending do
        local entry = pending[index]
        local due = STOP_REPEAT.at[entry.done + 1]
        if due and clock - entry.at >= due then
            entry.done = entry.done + 1
            pcall(entry.send)
        end
        if entry.done >= #STOP_REPEAT.at then table.remove(pending, index) else index = index + 1 end
    end
end
local MUTED_HOLD = 0.6       -- seconds a patient remark still waits for a game line whose voice is known to be stopped
local DEFAULT_TTL = 3         -- a remark that cannot be heard within about 3 s of its moment is dropped
local SCENE_GAP = 1.2         -- seconds of quiet after a game scene or line before a remark that waited for it starts
local HARD_TIER = 4           -- scene tiers from here on are cinematics: a speaker with playThrough is still stopped by them
local PATIENCE_MAX = 60       -- the longest a remark may wait for a game scene (seconds)
local STALE_GRACE = 2         -- seconds past its ttl that a request with no reply yet is given up (its reply could not be played any more)
local REQUEUES = 2            -- how many times a remark taken back at a scene is written again
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

-- The anchor of a remark: the speaker's own, or, for a remark that is held until V gets there (`hold`), the speaker's `approach`
-- object while the anchor is not there yet (the cab V walks up to). Talk never uses `approach`.
local function anchorFor(speaker, player, entry)
    local object, entity = resolveAnchor(speaker, player)
    if entity or not speaker.approach or not entry or not entry.hold then return object, entity end
    return resolveAnchor({anchor = speaker.approach}, player)
end

local function speakerAvailable(speaker, player)
    if not speaker.addon.enabled then return false end
    if speaker.available == nil then return true end
    local ok, value = pcall(speaker.available, player)
    return ok and value == true
end

-- What made the scene gate close, for the log: the flags the observer sampled ("dialogue+tier=3"). The first live ride with the Delamain
-- cab shows which of them the game's own cab dialogue raises.
local function sceneSignals(sample)
    local parts = {}
    if sample.dialogue then parts[#parts + 1] = 'dialogue' end
    if sample.choices then parts[#parts + 1] = 'choices' end
    if sample.call then parts[#parts + 1] = 'call' end
    if sample.replacer then parts[#parts + 1] = 'replacer' end
    if sample.tier ~= nil and sample.tier ~= 1 then parts[#parts + 1] = 'tier=' .. tostring(sample.tier) end
    return table.concat(parts, '+')
end

-- blocked, why, signals. `withLine` also counts a game dialogue line being shown now (M.gameLine): it keeps a remark from starting over
-- the game's own voice, but never cuts one that already plays (the scene flags do that, see trackFlight).
-- True while a game scene whose lines this speaker's add-on has just silenced is the only reason the scene gate is closed: the scene
-- keeps running without a voice, so its dialogue flag and its (non-cinematic) tier are no reason to stay quiet. Choices, a call, a
-- replacer and the cinematic tiers still close the gate.
local function silencedScene(sample, speaker)
    local addon = speaker and speaker.addon
    if not addon or not addon.mutedUntil or clock >= addon.mutedUntil then return false end
    if sample.choices or sample.call or sample.replacer then return false end
    return (tonumber(sample.tier) or 1) < HARD_TIER
end

local function sceneBlocked(sample, speaker, withLine)
    if type(sample) ~= 'table' or sample.available ~= true then return true, 'observation-unavailable' end
    local silenced = silencedScene(sample, speaker)
    if sample.choices or sample.call or sample.replacer or (sample.dialogue and not silenced) then
        return true, 'scene', sceneSignals(sample)
    end
    local tiers = speaker and speaker.sceneTiers or {1}
    local allowed = false
    for _, tier in ipairs(tiers) do if sample.tier == tier then allowed = true end end
    if not allowed and not silenced then return true, 'scene-tier', sceneSignals(sample) end
    if withLine and watch.gameLineUntil and clock < watch.gameLineUntil then return true, 'game-line', 'subtitle' end
    return false
end

-- A call, a replacer (Johnny) or a cinematic tier: stops even a line that plays through ordinary game scenes.
local function hardScene(sample)
    if type(sample) ~= 'table' then return true end
    return sample.call == true or sample.replacer == true or (tonumber(sample.tier) or 1) >= HARD_TIER
end

-- The reasons a patient remark waits out (it is not dropped for them).
local function holdable(why) return why == 'scene' or why == 'scene-tier' or why == 'game-line' end

local function relevantNow(entry)
    if type(entry.relevant) ~= 'function' then return true end
    local ok, value = pcall(entry.relevant)
    return ok and value == true
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

local UNAVAILABLE_GRACE = 2.5   -- seconds a remark still waiting to be heard keeps its speaker after the speaker stops being available

-- What speech.lua is told about the remark in flight (init.lua seams hold and menus; pure Lua fields there, never a native call).
local function setHold(id)
    if heldRequest == id then return end
    heldRequest = id
    if host and host.hold then pcall(host.hold, id) end
end

local function setMenus(id)
    if menuRequest == id then return end
    menuRequest = id
    if host and host.menus then pcall(host.menus, id) end
end

local function release(reason, stop, detail, cut)
    local current = flight
    if not current then return end
    pcall(lease, false)
    setHold(nil); setMenus(nil)
    if stop and host and host.drop then pcall(host.drop, current.requestId, reason, current.entity) end
    flight = nil
    local priorLast = current.speaker.lastAt
    current.speaker.lastAt = clock
    lastSpeechEndAt = clock
    local addon = current.speaker.addon
    local heard = current.stage == 'playing' or current.stage == 'captions'
    if heard then addon.lastRemarkAt = clock
    elseif current.episode == addon.episode and current.episodeStart == addon.episode.start and addon.episode.count > 0 then
        addon.episode.count = addon.episode.count - 1   -- nothing was heard: the budget is not spent
    end
    -- A patient remark taken back at a game scene or line before a word was heard waits for it to end and is written again (its
    -- moment has not passed): the speaker's gap does not count, nothing was heard.
    local entry, requeued = current.entry, false
    if not heard and entry and entry.patient and (holdable(reason) or reason == 'stale') and addon.enabled and clock <= entry.patienceEnd
        and (entry.requeues or 0) < REQUEUES and #queue < LIMITS.queue then
        local duplicate = false
        for _, other in ipairs(queue) do
            if other.speaker == entry.speaker and other.event.event == entry.event.event then duplicate = true end
        end
        if not duplicate then
            entry.requeues = (entry.requeues or 0) + 1
            if reason == 'stale' then
                -- No scene to wait for: the reply was too slow (a cold model, a busy bridge). Ask again with a fresh clock.
                entry.at, entry.expires, entry.sceneAt, entry.clearAt = clock, clock + entry.ttl, nil, nil
            else
                entry.sceneAt, entry.clearAt = clock, nil
                entry.heldAt = entry.heldAt or clock
                if entry.expires < entry.patienceEnd then entry.expires = entry.patienceEnd end
            end
            current.speaker.lastAt = priorLast
            queue[#queue + 1] = entry
            requeued = true
        end
    end
    log('Remark released: ' .. current.speaker.key .. ' event=' .. current.event .. ' reason=' .. tostring(reason)
        .. (current.refused and (' refused=' .. current.refused) or '')
        .. (detail and detail ~= '' and (' signals=' .. detail) or '') .. ' spoken=' .. tostring(heard)
        .. (cut and (' voice-stopped=' .. cut) or '')
        .. (requeued and ' (taken back; it is asked for again)' or ''))
    emitTo(current.speaker.addon, 'remarkFinished', {speaker = current.speaker.id, event = current.event,
        reason = reason, spoken = heard, requeued = requeued})
end

local function drop(entry, reason)
    log('Remark dropped: ' .. entry.speaker.key .. ' event=' .. entry.event.event .. ' reason=' .. tostring(reason))
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
    -- The bridge spaces remarks written by the Local AI (LOCAL_REMARK_GAP_S) unless the player chose a gap; once it has said so, wait that
    -- long here instead of asking and being refused (a refused moment is lost). Priority 5 is never held by it.
    if addon.localGap and priority < 5 and not addon.values.remarkGapChosen and addon.localGap > gap then gap = addon.localGap end
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
        lastRemarkAt = nil, quietUntil = nil, memories = {}, warm = nil, lineRules = {}}
    if not GAPS[addon.values.remarkGap] then addon.values.remarkGap = GAP_DEFAULT end
    if not CAPS[addon.values.remarkCap] then addon.values.remarkCap = CAP_DEFAULT end
    if type(addon.values.replaceGameLines) ~= 'boolean' then addon.values.replaceGameLines = true end
    if type(addon.values.markLines) ~= 'boolean' then addon.values.markLines = true end
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

--- handle:speaker({id, name, anchor, available, talk, group, minGap, sceneTiers, talkPriority, playThrough, voiceFrom, approach, face}) -> profileKey
--- voiceFrom(player) -> GameObject (optional): where the voice is heard from, when that is not the anchor (Skippy: the gun in V's
--- hand while the anchor stays V). Asked once when a reply starts; it only moves the sound (pan and distance), nothing else.
--- approach(player) -> GameObject (optional): the anchor before V reaches it (the Delamain cab V walks up to, while the 'vehicle'
--- anchor is still empty). Only a remark with `hold` uses it, and only while the anchor itself is not there; talk never does.
--- face = {rig = 'base\...\<head>_skeleton.rig'} (optional): the speaker's face on a screen (the Delamain cab's seat-back screens
--- film an NPC with Delamain's head). While the add-on watches it (handle:watchFace), the NPC that spawns with that face_rig rig gets
--- the main mod's gated speech graph, and the speaker's lines move its mouth. docs/ADDON_API.md, "A face on a screen".
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
    if def.voiceFrom ~= nil and type(def.voiceFrom) ~= 'function' then return nil, 'voiceFrom must be a function' end
    if def.approach ~= nil and type(def.approach) ~= 'function' then return nil, 'approach must be a function' end
    local faceRig = nil
    if def.face ~= nil then
        local rig = type(def.face) == 'table' and def.face.rig
        if type(rig) ~= 'string' or #rig > 200 or not rig:match('^[%w_\\/%.%-]+%.rig$') then return nil, 'face.rig must be a .rig path' end
        faceRig = rig
    end
    local tiers = {1}
    if type(def.sceneTiers) == 'table' then
        tiers = {}
        for _, tier in ipairs(def.sceneTiers) do if type(tier) == 'number' and tier >= 1 and tier <= 5 then tiers[#tiers + 1] = tier end end
        if #tiers == 0 then tiers = {1} end
    end
    local key = 'addon-' .. addon.id .. '-' .. def.id
    local speaker = {addon = addon, id = def.id, key = key, name = name, anchor = anchor, available = def.available,
        talk = def.talk ~= false, group = def.group == true, minGap = number(def.minGap, 2, 600, 8),
        talkPriority = number(def.talkPriority, 0, 100, 0), sceneTiers = tiers, playThrough = def.playThrough == true,
        voiceFrom = def.voiceFrom, approach = def.approach, faceRig = faceRig, faceWatched = false,
        contexts = {}, contextOrder = {}, contextTiers = {}, lastAt = nil, events = {}, warmedAt = nil, mode = nil}
    addon.speakers[def.id] = speaker
    speakers[key] = speaker
    if host and host.registerProfile then pcall(host.registerProfile, key) end
    return key
end)

--- handle:remark(speakerId, {event, text, facts, priority, ttl, maxWords, interrupt, cooldown, patience, relevant, hold, holdMax, menus})
--- -> true, or false and the reason.
--- hold() -> bool (optional): the remark is written and voiced as soon as it can be, but kept silent while hold() is true (checked on
--- the 0.1 s tick; handle:releaseHold plays it at once). For a line that must start the instant something happens (Delamain's welcome
--- the moment V sits) without waiting for the text and voice then. Given up, unheard, after holdMax seconds (1 to 30, default 20).
--- menus = true | function() -> bool (optional): while the remark plays (or is held), an open game menu (the cab's destination map)
--- does not pause it. The function form is checked on the 0.1 s tick.
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
    -- patience (seconds, 0 = none): the remark waits for a game scene or dialogue line instead of being dropped for it, then goes after
    -- a short gap, while `relevant()` (optional, cheap) still says the moment stands. Without it a remark that meets a scene is dropped.
    entry.patienceEnd = clock + number(event.patience, 0, PATIENCE_MAX, 0)
    entry.patient = number(event.patience, 0, PATIENCE_MAX, 0) > 0
    entry.relevant = type(event.relevant) == 'function' and event.relevant or nil
    if event.hold ~= nil and type(event.hold) ~= 'function' then return false, 'hold must be a function' end
    if event.menus ~= nil and event.menus ~= true and event.menus ~= false and type(event.menus) ~= 'function' then
        return false, 'menus must be true, false or a function'
    end
    entry.hold = event.hold
    entry.holdMax = number(event.holdMax, 1, 30, 20)
    entry.menus = (event.menus == true or type(event.menus) == 'function') and event.menus or nil
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

--- handle:settings({title, description, remarkCap = true|false, fixed = {replaceGameLines = bool, markLines = bool}, items = {{id, label, kind = 'bool'|'select', default, description, elements}}})
--- `remarkCap = false` hides the built-in "Most remarks per fight" setting for an add-on whose remarks are not tied to fights (a ride, say):
--- the player is not offered it, and the default count still guards the add-on's request budget.
--- `fixed` takes the two on/off built-ins away from the player and sets them for good: `replaceGameLines = true` (the game's own lines of the
--- character are always replaced, the toggle is not shown), `markLines = false` (the add-on's subtitles never carry " (AI)", no toggle).
Handle.settings = guard('settings', function(self, section)
    local addon = self and self.record
    if not addon or addons[addon.id] ~= addon then return false, 'unknown add-on' end
    if type(section) ~= 'table' or type(section.items) ~= 'table' then return false, 'settings need items' end
    local title = trim(section.title, 60) or addon.name
    local items = {}
    for _, item in ipairs(section.items) do
        if #items >= LIMITS.settings then break end
        if type(item) ~= 'table' or type(item.id) ~= 'string' or #item.id > 32 or not item.id:match('^[%w_]+$') then return false, 'invalid setting id' end
        if item.id == 'remarkGap' or item.id == 'remarkCap' or item.id == 'remarkGapChosen' or item.id == 'remarkRate'
            or item.id == 'replaceGameLines' or item.id == 'markLines' then
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
    local fixed = {}
    if type(section.fixed) == 'table' then
        if type(section.fixed.replaceGameLines) == 'boolean' then fixed.replaceGameLines = section.fixed.replaceGameLines end
        if type(section.fixed.markLines) == 'boolean' then fixed.markLines = section.fixed.markLines end
    end
    addon.settingsDef = {title = title, description = trim(section.description, 300) or '', items = items, remarkCap = section.remarkCap ~= false,
        fixed = fixed}
    for _, item in ipairs(items) do
        local value = addon.values[item.id]
        local valid = (item.kind == 'bool' and type(value) == 'boolean')
            or (item.kind == 'select' and type(value) == 'number' and value >= 1 and value <= #item.elements and value % 1 == 0)
        if not valid then addon.values[item.id] = item.default end
    end
    return true
end)

--- handle:replaceGameLines({name, match, active, audio, audioVerified}) -> true, or false and the reason.
--- Declares which game subtitle lines are this add-on's character's (docs/ADDON_API.md, "Replacing the game's own lines"). While the
--- player's built-in "Replace the game's own lines" is on (default), the main mod keeps those lines off the screen and stops their voice.
---   match(line, context) -> bool   the add-on's own test of a game line (line.speakerName, line.speaker, line.type; context.typeName());
---                                  runs once per game line while active() is true, so keep it to a few string reads
---   active() -> bool               optional: only while this is true (V holds the gun, V sits in the cab)
---   audio = {'event', ...}         optional: Wwise events stopped on the line's speaker (the voice; at most 4, each a plain name)
---   audioVerified                  true once it is known (heard in the game) that the voice really stops: a patient remark then
---                                  barely waits for the line; otherwise it waits for the whole line, as the voice may still play
Handle.replaceGameLines = guard('replaceGameLines', function(self, def)
    local addon = self and self.record
    if not addon or addons[addon.id] ~= addon then return false, 'unknown add-on' end
    if type(def) ~= 'table' or type(def.match) ~= 'function' then return false, 'match must be a function' end
    if def.active ~= nil and type(def.active) ~= 'function' then return false, 'active must be a function' end
    local audio = {}
    if def.audio ~= nil then
        if type(def.audio) ~= 'table' or #def.audio > 4 then return false, 'audio must be a list of at most 4 event names' end
        for _, name in ipairs(def.audio) do
            if type(name) ~= 'string' or #name > 64 or not name:match('^[%w_]+$') then return false, 'invalid audio event name' end
            audio[#audio + 1] = name
        end
    end
    if #addon.lineRules >= 4 then return false, 'too many line rules' end
    addon.lineRules[#addon.lineRules + 1] = {addon = addon, name = trim(def.name, 40) or addon.name, match = def.match,
        active = def.active, audio = audio, audioVerified = def.audioVerified == true}
    lineRulesDeclared = true
    if host and host.installLineRules then pcall(host.installLineRules) end
    return true
end)

--- A built-in on/off setting's value as it applies: the add-on's `fixed` value when it set one, else the player's choice (default on).
local function builtIn(addon, key)
    local fixed = addon.settingsDef and addon.settingsDef.fixed
    if fixed and fixed[key] ~= nil then return fixed[key] end
    return addon.values[key] ~= false
end

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
        for id, speaker in pairs(addon.speakers) do if speaker.faceWatched then Handle.watchFace(self, id, false) end end
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

--- handle:releaseHold(speakerId) : the speaker's held remark (`hold`) plays now, without waiting for the next tick. true when one was held.
Handle.releaseHold = guard('releaseHold', function(self, speakerId)
    local speaker = speakerOf(self, speakerId)
    if not speaker then return false, 'unknown speaker' end
    if not flight or flight.speaker ~= speaker or not flight.holding then return false end
    flight.holding = false
    setHold(nil)
    log(string.format('Remark hold released: %s event=%s after %.1fs', speaker.key, flight.event, clock - (flight.holdSince or clock)))
    return true
end)

--- handle:watchFace(speakerId, on) : starts or ends the watch of the speaker's screen face (its `face.rig`). While it lasts, the NPC
--- that spawns with that face_rig rig is prepared for the speaker's lines (r6/scripts/CyberpunkConvai/Face.reds WatchScreenFace).
--- Watch only while the moment lasts (the Delamain cab: while a cab exists), so the character is never touched anywhere else.
--- One call into the face service per change; nothing runs per frame. true when the watch is now as asked.
Handle.watchFace = guard('watchFace', function(self, speakerId, on)
    local speaker = speakerOf(self, speakerId)
    if not speaker then return false, 'unknown speaker' end
    if not speaker.faceRig then return false, 'speaker has no face' end
    on = on == true and speaker.addon.enabled
    if speaker.faceWatched == on then return true end
    if on then unwatchFaces[speaker.faceRig] = nil end
    local found, service = pcall(function() return host and host.faceService and host.faceService() end)
    if not found or not service then return false, 'face service unavailable' end
    local ok = pcall(function() service:WatchScreenFace(speaker.faceRig, on) end)
    if not ok then return false, 'face service failed' end
    speaker.faceWatched = on
    log('Screen face ' .. (on and 'watched' or 'released') .. ': ' .. speaker.key)
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

--- handle:live() -> true from the first tick of a session until the main mod releases its references (a load, a detach, a death,
--- fast travel, shutdown). An add-on's game hooks (Observe callbacks) return at once when it is false: the engine is then
--- destroying or building the world, and a native call from a callback on a half-built or half-destroyed object can crash.
--- A plain boolean read; costs nothing.
function Handle.live()
    return sessionOpen == true
end

--- handle:party() -> the profile keys of the companions that follow V now. A read for the add-on's own events (a ride, a fight):
--- it costs one party lookup, never runs on its own, and returns an empty list when the party cannot be read.
function Handle.party(self)
    local addon = self and self.record
    local out = {}
    if not addon or addons[addon.id] ~= addon or not host or type(host.partyProfiles) ~= 'function' then return out end
    local ok, list = pcall(host.partyProfiles)
    if ok and type(list) == 'table' then
        for _, key in ipairs(list) do if type(key) == 'string' and #out < 16 then out[#out + 1] = key end end
    end
    return out
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
    elseif state.speechId == id and flight.holding then
        -- Written and voiced, kept silent by speech.lua until the add-on's hold() says go (or handle:releaseHold). Not heard yet.
        if flight.stage ~= 'held' then
            flight.stage = 'held'
            log('Remark ready, held: ' .. flight.speaker.key .. ' event=' .. flight.event .. string.format(' after %.1fs', clock - flight.at))
        end
    elseif state.speechId == id then
        if flight.stage ~= 'playing' then
            -- The lease already says "playing" when the reply was accepted (canDeliver); it is written again only if it did not.
            if not flight.playbackAt then flight.playbackAt, flight.leaseAt = os.time(), nil end
            flight.stage = 'playing'
            log('Remark played: ' .. flight.speaker.key .. ' event=' .. flight.event .. string.format(' after %.1fs', clock - flight.at))
            emitTo(flight.speaker.addon, 'remarkStarted', {speaker = flight.speaker.id, event = flight.event, text = flight.text})
        end
    elseif flight.stage == 'pending' and state.captions and not state.speechId then
        -- Subtitles only (voice off): the caption this reply showed owns the turn until it ends.
        if not flight.playbackAt then flight.playbackAt, flight.leaseAt = os.time(), nil end
        flight.stage = 'captions'
        log('Remark played (captions only): ' .. flight.speaker.key .. ' event=' .. flight.event .. string.format(' after %.1fs', clock - flight.at))
        emitTo(flight.speaker.addon, 'remarkStarted', {speaker = flight.speaker.id, event = flight.event, text = flight.text})
    elseif flight.stage == 'captions' and state.captions then
        -- still on screen
    else
        -- A voice that stopped before its end says why (speech.lua's stop reason and error), so a remark that was cut is told from one
        -- that was heard to its end.
        local cut = nil
        if flight.stage == 'playing' and state.speechStop and state.speechStop ~= 'finished' then
            cut = tostring(state.speechStop) .. (state.speechError and (' (' .. tostring(state.speechError) .. ')') or '')
        end
        release(flight.stage == 'pending' and 'not-delivered' or 'finished', false, nil, cut)
        return
    end
    -- A request nobody has answered long after its moment (the bridge is busy or the model is cold) is withdrawn: its reply could not be
    -- played any more (canDeliver), and it would keep every later remark of the ride waiting behind it.
    if flight.stage == 'pending' and clock - flight.at > flight.ttl + STALE_GRACE then release('stale', true); return end
    -- A held remark (hold): released when hold() turns false, given up unheard after holdMax. A menus remark keeps playing in menus.
    local entry = flight.entry
    if flight.holding then
        local ok, wait = pcall(entry.hold)
        if ok and wait ~= true then
            flight.holding = false
            setHold(nil)
            log(string.format('Remark hold released: %s event=%s after %.1fs', flight.speaker.key, flight.event, clock - flight.holdSince))
        elseif clock - flight.holdSince > entry.holdMax then release('hold-expired', true); return end
    end
    if entry and entry.menus then
        local wanted = entry.menus == true
        if not wanted then local ok, value = pcall(entry.menus); wanted = ok and value == true end
        setMenus(wanted and id or nil)
    end
    -- A conversation the player starts, a scene, or the speaker going away ends the remark at once. A speaker that plays through
    -- (the Delamain cab: the game's own cab dialogue is a quest scene that begins and ends around its lines) finishes a line that has
    -- started when an ordinary scene begins; a call, a replacer or a cinematic tier still stops it, and so does a player's own turn.
    local manual = state.active or state.microphone or state.group or state.phone
    local blocked, why, detail = sceneBlocked(state.sample, flight.speaker)
    -- A held remark counts as playing here (it plays through ordinary scenes like any of its speaker's lines), but not as heard.
    local playing = flight.stage == 'playing' or flight.stage == 'captions' or flight.stage == 'held'
    if manual then release('manual-priority', true); return end
    if blocked then
        if playing and flight.speaker.playThrough and why ~= 'observation-unavailable' and not hardScene(state.sample) then
            if not flight.throughLogged then
                flight.throughLogged = true
                log('Remark plays through a game scene: ' .. flight.speaker.key .. ' event=' .. flight.event .. ' signals=' .. tostring(detail))
            end
        else release(why, true, detail); return end
    end
    -- A line that has started finishes even if its speaker stops being available (V steps out of the cab as it ends, the mount
    -- flickers during a seat change): only the add-on being switched off or a scene cuts it. One still waiting to be heard needs the
    -- speaker, but gets a moment of grace before it is given up.
    if speakerAvailable(flight.speaker, player) then flight.lostAt = nil
    elseif not playing then
        flight.lostAt = flight.lostAt or clock
        if clock - flight.lostAt > UNAVAILABLE_GRACE then release('speaker-unavailable', true); return end
    end
    for _, entry in ipairs(queue) do
        if entry.event.interrupt and entry.event.priority > flight.priority then release('interrupted', true); return end
    end
    if not lease(true) then release('lease-write-failed', true) end
end

local function byPriority(a, b)
    if a.event.priority ~= b.event.priority then return a.event.priority > b.event.priority end
    return a.at < b.at
end

local function schedule(player, state, worldReady)
    if flight or #queue == 0 then return end
    for index = #queue, 1, -1 do
        local entry = queue[index]
        -- A patient remark waits out a game scene or dialogue line (it is not dropped for one): its clock stops running down until the
        -- scene is over and a short gap has passed. Only while it waits is any of this evaluated, and only on the add-on tick.
        if entry.patient and entry.speaker.addon.enabled then
            local blocked, why, detail = sceneBlocked(state.sample, entry.speaker, entry.patient == true)
            if blocked and holdable(why) and clock <= entry.patienceEnd then
                if not entry.sceneAt then
                    entry.heldAt = entry.heldAt or clock
                    log('Remark held: ' .. entry.speaker.key .. ' event=' .. entry.event.event .. ' reason=' .. why .. ' signals=' .. tostring(detail)
                        .. ' patience=' .. string.format('%.0f', entry.patienceEnd - clock) .. 's')
                end
                entry.sceneAt, entry.clearAt = clock, nil
                if entry.expires < entry.patienceEnd then entry.expires = entry.patienceEnd end
            elseif not blocked and entry.sceneAt and not entry.clearAt then entry.clearAt = clock end
        end
        -- A remark whose moment has gone (the add-on says so) is not spoken late; a flicker of a moment is forgiven.
        if entry.relevant then
            if relevantNow(entry) then entry.irrelevantAt = nil
            else
                entry.irrelevantAt = entry.irrelevantAt or clock
                if clock - entry.irrelevantAt > UNAVAILABLE_GRACE then table.remove(queue, index); drop(entry, 'irrelevant'); entry = nil end
            end
        end
        if entry and clock > entry.expires then table.remove(queue, index); drop(entry, 'expired') end
    end
    if #queue == 0 or not worldReady or not host or not host.submit then return end
    if state.active or state.microphone or state.group or state.phone or state.automatic
        or state.pendingId or state.speechId or state.captions then return end
    if clock - lastSpeechEndAt < GLOBAL_GAP then return end
    if not outputs(player).enabled then return end
    table.sort(queue, byPriority)
    local keep = {}
    local function restore()
        for _, waiting in ipairs(keep) do queue[#queue + 1] = waiting end
        keep = {}
        table.sort(queue, byPriority)
    end
    while #queue > 0 do
        local entry = table.remove(queue, 1)
        local speaker = entry.speaker
        local blocked, why = sceneBlocked(state.sample, speaker, entry.patient == true)
        local object, entity = nil, nil
        if not blocked and speakerAvailable(speaker, player) then object, entity = anchorFor(speaker, player, entry) end
        if blocked and entry.patient and holdable(why) and clock <= entry.patienceEnd then keep[#keep + 1] = entry
        elseif blocked then drop(entry, why)
        elseif entry.sceneAt and (not entry.clearAt or clock - entry.clearAt < SCENE_GAP) then
            -- The scene is over: a short gap more, so the remark does not start on the heels of the game's last word.
            entry.clearAt = entry.clearAt or clock
            keep[#keep + 1] = entry
        elseif entry.relevant and not relevantNow(entry) then keep[#keep + 1] = entry
        elseif not entity then drop(entry, 'speaker-unavailable')
        elseif speaker.lastAt and clock - speaker.lastAt < speaker.minGap then drop(entry, 'speaker-cooldown')
        elseif rateBlocked(speaker.addon, entry.event.priority) then drop(entry, rateBlocked(speaker.addon, entry.event.priority))
        else
            local generation = host.nextGeneration()
            local now = os.time()
            local event = entry.event
            -- A remark that waited starts its clock now: it was written for this moment, not for the one it first met.
            local waited = entry.heldAt and clock - entry.heldAt or nil
            if entry.sceneAt then entry.at, entry.expires = clock, clock + entry.ttl end
            local context = {generation = generation, entity = entity, name = speaker.name, bodyType = '',
                profileKey = speaker.key, sentAt = now, voiceOnly = true,
                text = event.text or ('[' .. speaker.addon.name .. '] ' .. event.event),
                reaction = {kind = 'addon', addon = speaker.addon.id, speaker = speaker.id, event = event.event,
                    -- os.time() is whole seconds (up to 1 s behind the real moment): the extra second keeps the bridge's deadline from
                    -- falling before the game's own (canDeliver judges staleness with the exact clock).
                    priority = event.priority, expiresAt = math.floor((now + 1 + math.max(1, entry.expires - clock)) * 1000)},
                addon = {id = speaker.addon.id, speaker = speaker.id, event = event.event, text = event.text,
                    facts = event.facts, maxWords = event.maxWords, mode = speaker.mode, blocks = speakerBlocks(speaker),
                    stock = event.stock or nil}}
            context.requestId = tostring(now) .. '-' .. tostring(generation) .. '-' .. entity
            local episode = episodeOf(speaker.addon)
            flight = {requestId = context.requestId, speaker = speaker, event = event.event, priority = event.priority,
                stage = 'pending', entity = entity, episode = episode, episodeStart = episode.start, at = entry.at, ttl = entry.ttl or DEFAULT_TTL,
                entry = entry}
            -- A remark with hold whose moment has not come yet is voiced silent (speech.lua holds it) until hold() says go.
            if entry.hold then
                local okHold, wait = pcall(entry.hold)
                if okHold and wait == true then flight.holding, flight.holdSince = true, clock; setHold(context.requestId) end
            end
            if entry.menus then setMenus(context.requestId) end
            local ok, sent = false, false
            if lease(true) then ok, sent = pcall(host.submit, context, object) end
            restore()
            if ok and sent then
                episode.count = episode.count + 1
                -- No build-up behind the remark in flight: only the strongest waiting one is kept (the queue is sorted, best first).
                while #queue > 1 do drop(table.remove(queue), 'replaced') end
                if event.cooldown > 0 then speaker.events[event.event] = clock end
                log('Remark: ' .. speaker.key .. ' event=' .. event.event .. ' priority=' .. event.priority
                    .. (waited and string.format(' waited=%.1fs', waited) or '') .. (flight.holding and ' (held until its moment)' or ''))
            else
                pcall(lease, false)
                flight = nil
                setHold(nil); setMenus(nil)
                drop(entry, 'request-write-failed')
            end
            return
        end
    end
    restore()
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
    if #STOP_REPEAT.pending > 0 then STOP_REPEAT.run() end
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
    if next(unwatchFaces) ~= nil and worldReady then
        -- Rigs a save load or death left watched (M.reset never calls the game): released now unless the add-on watched them again.
        local found, service = pcall(function() return host.faceService and host.faceService() end)
        if not found then service = nil end
        for rig in pairs(unwatchFaces) do if service then pcall(function() service:WatchScreenFace(rig, false) end) end end
        unwatchFaces = {}
    end
    trackFlight(player, state)
    schedule(player, state, worldReady)
    writeState(false)
end

--- A game dialogue line is being shown (mod/game-dialogue.lua, from the subtitle hooks: one call per line, never per frame). Remarks do
--- not start until it has ended plus SCENE_GAP, whether or not the scene flags caught it (remarks that asked for patience; the others
--- keep the scene gate alone); one that already plays is not cut by it.
--- `seconds` is the line's own duration when the game gives one, else an estimate from its text.
function M.gameLine(seconds, kind, measured)
    if not M.live or #order == 0 then return end
    seconds = number(seconds, 0.5, 15, 3)
    local untilAt = clock + seconds
    if not watch.gameLineUntil or untilAt > watch.gameLineUntil then watch.gameLineUntil = untilAt end
    if flight or #queue > 0 then
        log(string.format('Game line: %s for about %.1f s (%s); patient remarks wait for it', tostring(kind or 'line'), seconds,
            measured and 'its own duration' or 'estimated'))
    end
end

--- True from the first handle:replaceGameLines on. One boolean read (mod/game-dialogue.lua asks it for every subtitle line).
function M.lineRulesWanted() return lineRulesDeclared end

--- mod/game-dialogue.lua, for a game subtitle line: which add-on rule claims it (nil: none), and whether the player's "Replace the
--- game's own lines" is on for it. Runs the add-on's own cheap test, only for an enabled add-on whose active() holds.
function M.matchLine(line, context)
    if not lineRulesDeclared then return nil end
    for _, id in ipairs(order) do
        local addon = addons[id]
        if addon and addon.enabled then
            for _, rule in ipairs(addon.lineRules) do
                local active = true
                if rule.active then
                    local ok, value = pcall(rule.active)
                    active = ok and value == true
                end
                if active then
                    local ok, hit = pcall(rule.match, line, context)
                    if ok and hit == true then return rule, builtIn(addon, 'replaceGameLines') end
                end
            end
        end
    end
    return nil
end

--- A game line of a rule was silenced (info: seconds, measured, id, subtitle, audio). One log line each, and the line counts as a
--- game line for the remarks that wait: for its whole length unless the rule's voice stop is verified. The scene it belongs to keeps
--- running without a voice, so for that long its dialogue flag does not close the scene gate for this add-on (silencedScene).
function M.mutedLine(rule, info)
    if type(rule) ~= 'table' or type(info) ~= 'table' then return end
    local seconds = number(info.seconds, 0.5, 15, 3)
    log(string.format('muted game line: %s %s (subtitle=%s audio=%s %.1fs)', tostring(rule.name), tostring(info.id),
        tostring(info.subtitle), tostring(info.audio), seconds))
    rule.addon.mutedUntil = clock + seconds + 0.4
    -- A scene voice can start a moment after its subtitle line, and a Stop that came first finds nothing to stop: the same stop is sent
    -- again at STOP_REPEAT_AT seconds, on the 0.1 s tick that already runs (a few table reads, no scan, nothing per frame).
    if type(info.repeatStop) == 'function' and #rule.audio > 0 then
        local pending = STOP_REPEAT.pending
        if #pending >= STOP_REPEAT.max then table.remove(pending, 1) end
        pending[#pending + 1] = {send = info.repeatStop, at = clock, done = 0}
    end
    M.gameLine(rule.audioVerified and math.min(seconds, MUTED_HOLD) or seconds, rule.name, info.measured)
end

--- The speaker name for a subtitle: with "Mark our lines" on, an add-on speaker's own line carries a small tag (speech.lua, subtitles.lua).
function M.captionName(profileKey, name)
    local speaker = speakers[profileKey]
    if not speaker or type(name) ~= 'string' or not builtIn(speaker.addon, 'markLines') then return name end
    return name .. CAPTION_TAG
end

--- Where an add-on speaker's voice is heard from (its voiceFrom), for the reply that starts now (speech.lua, once per reply, never per
--- frame). nil: the anchor, as before. The object must be attached; anything else (an error, a missing weapon) is nil.
function M.voiceSource(profileKey, player)
    local speaker = type(profileKey) == 'string' and speakers[profileKey] or nil
    if not speaker or not speaker.voiceFrom or not player then return nil end
    local ok, object = pcall(speaker.voiceFrom, player)
    if not ok or not object then return nil end
    local attached, yes = pcall(function() return object:IsAttached() end)
    return attached and yes == true and object or nil
end

--- The NPC whose face moves with an add-on speaker's voice (its `face`), for the reply that starts now (speech.lua, once per reply, never per
--- frame), or nil (no face, not watched, or nothing prepared for it). Only the NPC the speaker's own watched rig prepared is ever returned
--- (Face.reds ScreenFace), attached and still running the gated graph (ConvaiFaceReady).
function M.faceActor(profileKey, player)
    local speaker = type(profileKey) == 'string' and speakers[profileKey] or nil
    if not speaker or not speaker.faceRig or not speaker.faceWatched or not player or not host or not host.faceService then return nil end
    local ok, object = pcall(function()
        local service = host.faceService()
        local id = service and service:ScreenFace(speaker.faceRig)
        if not id or tostring(id.hash) == '0ULL' or tostring(id.hash) == '0' then return nil end
        local npc = Game.FindEntityByID(id)
        if not npc or not npc:IsAttached() or not npc:ConvaiFaceReady() then return nil end
        return npc
    end)
    return ok and object or nil
end

--- The reply of an add-on remark arrived: may it play now? (init.lua reactionCanDeliver)
function M.canDeliver(context, player)
    if not flight or type(context) ~= 'table' or flight.requestId ~= context.requestId then return false end
    -- The moment has passed (the reply took too long): a late remark is worse than none.
    if flight.at and clock - flight.at > flight.ttl then release('stale', true); return false end
    local sample = host and host.sample and host.sample(player) or watch.sample
    local blocked, why, detail = sceneBlocked(sample, flight.speaker, flight.entry ~= nil and flight.entry.patient == true)
    if blocked then release(why, true, detail); return false end
    if not speakerAvailable(flight.speaker, player) then release('speaker-unavailable', true); return false end
    local _, entity = anchorFor(flight.speaker, player, flight.entry)
    if entity ~= context.entity then release('anchor-changed', true); return false end
    -- Accepted: the lease says "playing" now, before the voice starts. Until it did, the bridge judged the lease by the request's deadline
    -- alone and could cut a reply the game had just started when that deadline passed (probe.log 2026-10-14: companion-kill played and
    -- was released in the same second, bridge "Continuous speech owner changed").
    if not flight.playbackAt then
        flight.playbackAt, flight.leaseAt = os.time(), nil
        pcall(lease, true)
    end
    return true
end

--- The reply text of the remark in flight (init.lua, when the reply arrives): carried by `remarkStarted` as `text`, so an add-on can show it
--- somewhere of its own (Skippy's hologram). Plain text, at most 400 letters; nothing is stored for any other request.
function M.replyText(context, text)
    if not flight or type(context) ~= 'table' or flight.requestId ~= context.requestId or type(text) ~= 'string' then return end
    flight.text = trim(text, 400)
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
                        profileKey = speaker.key, voiceOnly = true, distance = 0, priority = speaker.talkPriority,
                        vehicle = speaker.anchor == 'vehicle' or nil}
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
    -- The refusal is named in the log line that releases the remark (trackFlight sees only "not delivered").
    if flight and flight.requestId == context.requestId then flight.refused = tostring(reply.errorCode) end
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
        -- The bridge also says how long it spaces remarks (rateBlocked then waits that long instead of asking and being refused).
        local gap = tonumber(reply.gap)
        if gap and gap >= 5 and gap <= 120 then speaker.addon.localGap = gap end
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
                    .. 'The biggest moments need only half of it. While its text comes from the Local AI '
                    .. 'and you keep the default, ' .. addon.name .. ' waits about 20 seconds between remarks to keep the graphics card free for the game.'}
            if not (def and def.remarkCap == false) then
                items[#items + 1] = {mcmId = 'addon:' .. id .. ':remarkCap', label = 'Most remarks per fight', kind = 'select', elements = caps,
                    value = addon.values.remarkCap, default = CAP_DEFAULT,
                    description = 'How many remarks ' .. addon.name .. ' may make in one fight (outside combat: in five minutes). '
                        .. 'The last one is kept for a big moment.'}
            end
            local fixed = def and def.fixed or {}
            if #addon.lineRules > 0 and fixed.replaceGameLines == nil then
                items[#items + 1] = {mcmId = 'addon:' .. id .. ':replaceGameLines', label = 'Replace the game\'s own lines', kind = 'bool',
                    value = addon.values.replaceGameLines, default = true,
                    description = 'Silences the game\'s own voice and subtitle lines of ' .. addon.name .. ' (the ones the game plays by itself) so '
                        .. 'that only ' .. addon.name .. '\'s own AI lines are heard. Only the voice and the subtitle are silenced: the scene, the '
                        .. 'quest, the map and the payment behind them run as always. Where the game\'s voice cannot be stopped, ' .. addon.name
                        .. ' waits for it to end.'}
            end
            if fixed.markLines == nil then
                items[#items + 1] = {mcmId = 'addon:' .. id .. ':markLines', label = 'Mark our lines in the subtitles', kind = 'bool',
                    value = addon.values.markLines, default = true,
                    description = 'Adds (AI) after ' .. addon.name .. '\'s name in the subtitles of its own lines, so you can tell them from the '
                        .. 'game\'s own lines. Turn it off once the game\'s own lines are replaced.'}
            end
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
    if key == 'remarkCap' and next(addon.speakers) ~= nil and not (addon.settingsDef and addon.settingsDef.remarkCap == false) then
        return addon, {id = 'remarkCap', kind = 'select', elements = CAPS}
    end
    local fixed = addon.settingsDef and addon.settingsDef.fixed or {}
    if key == 'markLines' and next(addon.speakers) ~= nil and fixed.markLines == nil then return addon, {id = 'markLines', kind = 'bool'} end
    if key == 'replaceGameLines' and #addon.lineRules > 0 and fixed.replaceGameLines == nil then
        return addon, {id = 'replaceGameLines', kind = 'bool'}
    end
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
    setHold(nil); setMenus(nil)
    watch, partyKnown, partyDirty = {}, nil, true
    outputsCache = nil
    STOP_REPEAT.pending = {}           -- repeated voice stops hold entity ids of a world that is going away
    local had = false
    for _, id in ipairs(order) do
        local addon = addons[id]
        local hadStock = clearStock(addon)
        if #addon.companionOrder > 0 or addon.state ~= nil or hadStock then had = true end
        addon.companion, addon.companionOrder, addon.state = {}, {}, nil
        addon.episode, addon.lastRemarkAt, addon.quietUntil, addon.paceUntil = {start = clock, count = 0}, nil, nil, nil
        addon.mutedUntil = nil
        for _, speaker in pairs(addon.speakers) do
            if speaker.faceWatched then unwatchFaces[speaker.faceRig] = true; speaker.faceWatched = false end
        end
    end
    if had then writeState(true) end
    if sessionOpen then sessionOpen = false; emit('sessionEnded', {reason = reason}) end
end

-- Tests only: the clock and internal tables.
M._test = {clock = function() return clock end, queue = function() return queue end, flight = function() return flight end,
    speakers = speakers, addons = addons}

return M
