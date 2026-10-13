-- "Auto-connect nearby characters": decides which world characters (not part of
-- the party) get their conversation connection and local voice prepared before
-- the player speaks to them, and explains the wait when nothing was prepared.
--
-- On (the default): a character the player looks at for a moment, or stands near, is wanted.
-- At most two are kept warm, one new start every few seconds, never in combat
-- or scenes, with a cooldown after a release; an unused one is released after
-- a while. The wanted list is published to runtime/nearby-connections.json and
-- the bridge (bridge/nearby-warm.mjs) opens the connections and prepares the
-- voices. Nothing here touches the world, the party or a conversation, and no notice
-- announces a warm-up. A player who talks before one finishes sees the short wait notice.
-- Off: nothing is prepared ahead. The same wait notice shows when the player starts talking to a
-- character that is not connected yet: talkNotice() returns it with the setting on or off (no hint about the setting).
--
-- Ranking of the two slots: a looked-at character first (looking is intent; it may replace the idlest unwanted
-- one), then nearby characters by prominence (tier-1 named, other named, generic residents and archetypes), then
-- by distance.
--
-- Conversation partner: a world character the player talks to (not a party member) becomes a partner, a separate
-- role like a temporary companion. It does not use one of the two slots. Its connection and voice stay warm while
-- V stays with it, and it is released when they part: V more than partnerRange metres away for partnerAway
-- seconds, no exchange for partnerIdle seconds, the character despawns, or a scene starts. Talking to someone else
-- makes the new character the partner and gives the previous one partnerGrace seconds. At most partnerMax (2, a
-- group chat) at once. A partner asked to follow leaves the role through promote() (or as soon as it is in the
-- party).
local ui = (convaiUiLocale or dofile('ui-locale.lua'))
local M = {version = 1}

M.DEFAULTS = {
    gazeDwell = 0.6,   -- seconds looking at one character before it is wanted
    radius = 5.0,      -- metres: standing this close also wants a character
    scanInterval = 1.0,
    maxWarm = 2,
    hold = 40,         -- seconds a character stays warm after it stops being wanted
    maxAge = 600,      -- the longest one character stays warm without a conversation
    cooldown = 20,     -- seconds before a released character may be warmed again
    ageCooldown = 180, -- ... after it was released for age
    stagger = 3,       -- seconds between two new warm-ups
    lookExpiry = 1.0,  -- a gaze sample older than this no longer counts
    heartbeat = 2,     -- the bridge treats a list older than a few seconds as empty
    partnerMax = 2,      -- conversation partners at once (a group chat has two)
    partnerRange = 15,   -- metres: farther than this counts as parting ways ...
    partnerAway = 20,    -- ... once it lasts this many seconds
    partnerIdle = 180,   -- seconds without an exchange before a partner is released
    partnerGrace = 30,   -- seconds the previous partner stays after V talks to someone else
}

-- Tier-1 named characters (the 24 with a hand-reviewed profile and voice; scripts/Create-MultilingualProfiles.mjs).
M.TIER1 = {}
for _, key in ipairs({'alex', 'alt-cunningham', 'claire-russell', 'evelyn-parker', 'jackie-welles', 'johnny-silverhand',
    'judy-alvarez', 'kerry-eurodyne', 'lizzy-wizzy', 'mama-welles', 'meredith-stout', 'misty-olszewski', 'mr-hands',
    'padre-ibarra', 'panam-palmer', 'pepe-najarro', 'regina-jones', 'river-ward', 'rogue-amendiares', 'solomon-reed',
    'songbird', 'takemura', 'viktor-vektor', 'wakako-okada'}) do M.TIER1[key] = true end

-- Prominence of a catalogue profile ({key, kind, tier}): 1 tier-1 named, 2 other named, 3 generic (a resident,
-- an archetype or any other non-named kind). A profile's own `tier`/`prominence` field wins when present.
function M.prominence(profile)
    if type(profile) ~= 'table' then return 2 end
    if profile.prominence == 1 or profile.prominence == 2 or profile.prominence == 3 then return profile.prominence end
    if profile.kind ~= nil and profile.kind ~= 'named' then return 3 end
    if profile.tier == 1 or M.TIER1[profile.key] then return 1 end
    return 2
end

local PATH = 'runtime/nearby-connections.json'
local STATE_PATH = 'runtime/party-connection-state.json'

local function readJson(path)
    local file = io.open(path, 'rb')
    if not file then return nil end
    local raw = file:read(262144); file:close()
    if type(raw) ~= 'string' or raw == '' then return nil end
    local ok, value = pcall(json.decode, raw)
    return ok and type(value) == 'table' and value or nil
end

-- The default publisher: an atomic runtime/nearby-connections.json (the two slots, then the conversation partners,
-- then the entity of each one that has an ID: a generic resident or archetype has no connection without its body).
local function publishFile(profiles, partners, entities)
    local function encode(list)
        local encoded = {}
        for _, key in ipairs(list or {}) do encoded[#encoded + 1] = json.encode(key) end
        return table.concat(encoded, ',')
    end
    local ids = {}
    for key, id in pairs(entities or {}) do ids[#ids + 1] = json.encode(key) .. ':' .. json.encode(id) end
    table.sort(ids)
    local file = io.open(PATH .. '.tmp', 'wb')
    if not file then return false end
    file:write('{"updated":' .. string.format('%.0f', os.time() * 1000) .. ',"profiles":[' .. encode(profiles)
        .. '],"partners":[' .. encode(partners) .. '],"entities":{' .. table.concat(ids, ',') .. '}}')
    file:close()
    os.remove(PATH)
    return os.rename(PATH .. '.tmp', PATH) ~= nil
end

-- True when the bridge reports this character's private connection ready.
local readCache = {at = nil, value = nil}
local function connectionReady(key)
    local now = os.time()
    if readCache.at ~= now then readCache = {at = now, value = readJson(STATE_PATH)} end
    local state = readCache.value
    if type(state) ~= 'table' or type(state.connections) ~= 'table' then return false end
    for _, connection in ipairs(state.connections) do
        if connection.profile == key and connection.scope == 'private' and connection.state == 'ready' then return true end
    end
    return false
end

function M.new(options)
    options = options or {}
    local cfg = {}
    for key, value in pairs(M.DEFAULTS) do cfg[key] = options[key] or value end
    local A = {}
    local clock, nextScan, lastStart = 0, 0, -math.huge
    local look = {}
    local active, cooling, partners = {}, {}, {}
    local lastSignature, lastPublish = nil, nil
    local publish = options.publish or publishFile
    -- heartbeat() runs every frame; its list work (keys, entity ids, a signature) is repeated only every
    -- heartbeatLook seconds of this clock (the list itself publishes every cfg.heartbeat). A frame whose
    -- heartbeat slot was taken looks again next frame.
    local mono = options.mono or os.clock
    local heartbeatLook, beatAt = options.heartbeatLook or 0.25, nil
    local ready = options.ready or connectionReady
    local wall = options.wall or os.time

    local function enabled()
        if type(options.enabled) ~= 'function' then return false end
        local ok, value = pcall(options.enabled)
        return ok and value == true
    end

    local function log(line)
        if type(options.log) == 'function' then pcall(options.log, line) end
    end

    local function keys()
        local result = {}
        for _, entry in ipairs(active) do result[#result + 1] = entry.key end
        return result
    end
    local function partnerKeys()
        local result = {}
        for _, partner in ipairs(partners) do result[#result + 1] = partner.key end
        return result
    end
    local function isParty(key) return type(options.party) == 'function' and options.party(key) == true end
    local function isPartner(key)
        for _, partner in ipairs(partners) do if partner.key == key then return partner end end
        return nil
    end
    local function prominence(key)
        if type(options.prominence) ~= 'function' then return 2 end
        local ok, value = pcall(options.prominence, key)
        return ok and (value == 1 or value == 2 or value == 3) and value or 2
    end

    -- Entity IDs ("<hash>ULL") of the listed characters, by profile key. The bridge uses them only for ambient
    -- profiles, which share one key between many bodies; the partner's wins over a slot of the same key.
    local function entityIds()
        local ids, signature = {}, {}
        for _, entry in ipairs(active) do if type(entry.entity) == 'string' then ids[entry.key] = entry.entity end end
        for _, partner in ipairs(partners) do if type(partner.id) == 'string' then ids[partner.key] = partner.id end end
        for key, id in pairs(ids) do signature[#signature + 1] = key .. '=' .. id end
        table.sort(signature)
        return ids, table.concat(signature, ',')
    end

    local function push(force)
        local list, partnerList = keys(), partnerKeys()
        local ids, idSignature = entityIds()
        local signature = (#list > 0 or #partnerList > 0) and table.concat(list, ',') .. '|' .. table.concat(partnerList, ',')
            .. '|' .. idSignature or ''
        local now = wall()
        if not force and signature == lastSignature and lastPublish and now - lastPublish < cfg.heartbeat then return end
        -- An unchanged heartbeat writes in a frame no other heartbeat writes in (init.lua convaiHeartbeatSlot).
        local slot = convaiHeartbeatSlot
        if not force and signature == lastSignature and lastPublish and type(slot) == 'function' and not slot() then
            return 'slot'
        end
        if pcall(publish, list, partnerList, ids) then lastSignature, lastPublish = signature, now end
    end

    local function releaseAll(reason)
        if #active > 0 or #partners > 0 then log('Auto-connect released all: ' .. reason) end
        active, partners = {}, {}
    end

    local function releasePartner(index, reason)
        local partner = table.remove(partners, index)
        cooling[partner.key] = clock + cfg.cooldown
        log('Auto-connect partner released ' .. partner.key .. ' (' .. reason .. ')')
    end

    -- The conversation partner(s): adopted while V talks to a world character, released when they part.
    local function updatePartners(context)
        local talking = context.talking
        if type(talking) == 'string' and talking ~= '' and not isParty(talking) then
            local partner = isPartner(talking)
            if not partner then
                partner = {key = talking, since = clock}
                table.insert(partners, 1, partner)
                -- The partner role replaces a slot it held: one connection, one owner.
                for index = #active, 1, -1 do if active[index].key == talking then table.remove(active, index) end end
                log('Auto-connect partner ' .. talking)
            end
            partner.lastExchange, partner.graceUntil, partner.awaySince = clock, nil, nil
            if context.talkingEntity ~= nil then partner.entity = context.talkingEntity end
            if type(context.talkingId) == 'string' then partner.id = context.talkingId end
            for _, other in ipairs(partners) do
                if other ~= partner and not other.graceUntil then other.graceUntil = clock + cfg.partnerGrace end
            end
        end
        table.sort(partners, function(a, b) return a.lastExchange > b.lastExchange end)
        while #partners > cfg.partnerMax do releasePartner(#partners, 'replaced') end
        for index = #partners, 1, -1 do
            local partner, reason = partners[index], nil
            if partner.key ~= talking then
                if isParty(partner.key) then reason = 'joined the party'
                elseif context.scene == true then reason = 'scene'
                elseif partner.graceUntil and clock >= partner.graceUntil then reason = 'another partner'
                elseif clock - partner.lastExchange > cfg.partnerIdle then reason = 'no exchange'
                elseif type(options.locate) == 'function' then
                    -- locate: metres from V, nil when the character is gone, false when unknown.
                    local ok, distance = pcall(options.locate, partner)
                    if ok and distance == nil then reason = 'left the area'
                    elseif ok and type(distance) == 'number' and distance > cfg.partnerRange then
                        partner.awaySince = partner.awaySince or clock
                        if clock - partner.awaySince >= cfg.partnerAway then reason = 'parted ways' end
                    elseif ok and type(distance) == 'number' then partner.awaySince = nil end
                end
            end
            if reason then releasePartner(index, reason) end
        end
    end

    -- A gaze sample, about every 0.2 s: the character V is facing (a profile
    -- that is enabled and not already in the party), or nil.
    function A.look(key, entity, name, dt)
        if not key or not entity then look = {}; return end
        if look.key ~= key or look.entity ~= entity then look = {key = key, entity = entity, name = name, dwell = 0} end
        look.dwell = look.dwell + (tonumber(dt) or 0)
        look.seen = clock
    end

    -- The notice for the wait at the start of a conversation: shown whenever the
    -- character is not connected yet, with the setting on or off.
    function A.talkNotice(key, name)
        if not key or ready(key) then return nil end
        return ui.t('Preparing connection to {name}…', {name = name})
    end

    -- Every frame, also while a menu pauses the game: keeps the list fresh for
    -- the bridge, which drops a list that stops being refreshed.
    function A.heartbeat()
        if #active > 0 or #partners > 0 or lastSignature ~= nil and lastSignature ~= '' then
            local at = mono()
            if beatAt and at >= beatAt and at - beatAt < heartbeatLook then return end
            if push(false) == 'slot' then beatAt = nil else beatAt = at end
        end
    end

    -- context: worldReady, blocked (combat, scene, call, vehicle), player,
    -- talking (the profile key of a conversation in progress, if any).
    function A.update(dt, context)
        context = context or {}
        if not enabled() then
            if #active > 0 or #partners > 0 or (lastSignature ~= nil and lastSignature ~= '') then
                releaseAll('setting off'); push(true)
            end
            look = {}
            return
        end
        if context.worldReady ~= true then return end
        clock = clock + (tonumber(dt) or 0)
        if look.key and clock - (look.seen or 0) > cfg.lookExpiry then look = {} end
        updatePartners(context)

        local wanted, order = {}, {}
        local function want(key, name, priority, distance, entity)
            -- A partner already has its own connection; it never takes a slot as well.
            if isPartner(key) then return end
            if not wanted[key] then
                wanted[key] = {key = key, name = name, priority = priority, distance = distance or 0,
                    prominence = priority == 2 and prominence(key) or 0, entity = entity}
                order[#order + 1] = wanted[key]
            elseif priority < wanted[key].priority then wanted[key].priority, wanted[key].entity = priority, entity end
        end
        if look.key and look.dwell >= cfg.gazeDwell then want(look.key, look.name, 1, 0, look.entity) end
        if not context.blocked and clock >= nextScan and type(options.scan) == 'function' then
            nextScan = clock + cfg.scanInterval
            local called, rows = pcall(options.scan, context.player, cfg.radius)
            if called and type(rows) == 'table' then
                for _, row in ipairs(rows) do want(row.key, row.name, 2, row.distance, row.entity) end
            end
        end
        table.sort(order, function(a, b)
            if a.priority ~= b.priority then return a.priority < b.priority end
            if a.prominence ~= b.prominence then return a.prominence < b.prominence end
            if a.distance ~= b.distance then return a.distance < b.distance end
            return a.key < b.key
        end)

        -- Refresh what is wanted; release what has been idle or too long.
        for index = #active, 1, -1 do
            local entry = active[index]
            local item = wanted[entry.key]
            -- The same profile key may now be another body (two residents): follow the one wanted most.
            if item then entry.lastWanted = clock; if type(item.entity) == 'string' then entry.entity = item.entity end end
            local idle, age = clock - entry.lastWanted, clock - entry.since
            if idle > cfg.hold or age > cfg.maxAge then
                cooling[entry.key] = clock + (age > cfg.maxAge and cfg.ageCooldown or cfg.cooldown)
                log('Auto-connect released ' .. entry.key .. (age > cfg.maxAge and ' (unused too long)' or ' (idle)'))
                table.remove(active, index)
            end
        end

        -- Admit new characters, best first, within the limits.
        if not context.blocked then
            for _, item in ipairs(order) do
                local key = item.key
                local present = false
                for _, entry in ipairs(active) do if entry.key == key then present = true end end
                if not present and item.priority > 0 and (cooling[key] or 0) <= clock
                    and clock - lastStart >= cfg.stagger
                    and not isParty(key) then
                    if #active >= cfg.maxWarm then
                        -- A looked-at character may take the place of the idlest one
                        -- that nobody wants right now.
                        local idlest
                        for index, entry in ipairs(active) do
                            if not wanted[entry.key] and (not idlest or entry.lastWanted < active[idlest].lastWanted) then idlest = index end
                        end
                        if item.priority == 1 and idlest then
                            cooling[active[idlest].key] = clock + cfg.cooldown
                            log('Auto-connect released ' .. active[idlest].key .. ' (replaced)')
                            table.remove(active, idlest)
                        end
                    end
                    if #active < cfg.maxWarm then
                        active[#active + 1] = {key = key, name = item.name, since = clock, lastWanted = clock,
                            reason = item.priority == 1 and 'gaze' or 'near', entity = type(item.entity) == 'string' and item.entity or nil}
                        lastStart = clock
                        log('Auto-connect warming ' .. key .. ' (' .. active[#active].reason .. ')')
                    end
                end
            end
        end
        push(false)
    end

    function A.reset()
        local had = #active > 0 or #partners > 0
        active, cooling, look, partners = {}, {}, {}, {}
        nextScan, lastStart = 0, -math.huge
        if had or (lastSignature ~= nil and lastSignature ~= '') then push(true) end
    end

    function A.active() return keys() end
    function A.partners() return partnerKeys() end
    -- The hook for asking a partner to follow: it leaves the partner role (the party owns its connection now).
    -- Returns true when it was a partner.
    function A.promote(key)
        for index, partner in ipairs(partners) do
            if partner.key == key then
                table.remove(partners, index)
                log('Auto-connect partner ' .. key .. ' joined the party')
                push(true)
                return true
            end
        end
        return false
    end
    function A.inspect()
        local rows = {}
        for _, entry in ipairs(active) do
            rows[#rows + 1] = {key = entry.key, reason = entry.reason, since = entry.since, lastWanted = entry.lastWanted}
        end
        local partnerRows = {}
        for _, partner in ipairs(partners) do
            partnerRows[#partnerRows + 1] = {key = partner.key, since = partner.since, lastExchange = partner.lastExchange,
                graceUntil = partner.graceUntil, awaySince = partner.awaySince}
        end
        return {active = rows, partners = partnerRows, clock = clock, look = look.key}
    end

    return A
end

return M
