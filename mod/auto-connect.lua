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
-- Spawned characters (docs/SPAWNED_CHARACTERS.md): a roster character that another mod or a spawner created is wanted from the first
-- scan that sees it near V (the scan runs once a second anyway). It does not take one of the two slots: it has its own, at most
-- maxSpawned (3), published as `spawned` beside `profiles`, with the same hold, age and cooldown rules. The bridge opens its
-- connection (on a player's own key only if its plan has room, bridge/party-connections.mjs spawnedWarmLimit), so the first talk
-- does not wait for it. A profile shared with a party member or a slot is one connection (the bridge keeps one page per profile).
-- The scan only reports what the camera sees, so the adapter also adds the spawned characters it remembers by entity ID that are
-- within group range (init.lua scanNearbyCharacters): a spawned character stays wanted, and stays connected, while it stands near V
-- wherever V looks. It has no age limit while it is wanted. A conversation partner that is a spawned character goes back to the
-- lane, not to a release, when the partner role ends while it is still near V (backToLane): its connection stays open.
-- A follower mod's own interaction menu (a choice hub, scene tier 2) and a game dialogue flag are not a scene for such a character:
-- they never end its partner role, and while the world is blocked (that menu, a vehicle, combat) the lane keeps what it holds, since
-- the scan that would report the follower is not asked (2026-10-18 live round: Night City Allies followers dropped within a minute).
-- A scripted scene proper (context.sceneReal, tier 3 or above) sends a spawned partner back to the lane, never to a release.
-- A look sample can say the character it faces is spawned (A.look): a gaze must not put it in a slot on a tick the scan skips.
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
    maxSpawned = 3,    -- spawned roster characters kept warm beside the two slots
    spawnedRadius = 8, -- metres: a released partner this close that is a spawned character goes back to the spawned lane
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

-- Tier-1 named characters (the 26 with a hand-reviewed profile and voice; scripts/Create-MultilingualProfiles.mjs).
M.TIER1 = {}
for _, key in ipairs({'alex', 'alt-cunningham', 'claire-russell', 'evelyn-parker', 'jackie-welles', 'johnny-silverhand',
    'judy-alvarez', 'kerry-eurodyne', 'lizzy-wizzy', 'lucy-kushinada', 'mama-welles', 'meredith-stout', 'misty-olszewski',
    'mr-hands', 'padre-ibarra', 'panam-palmer', 'pepe-najarro', 'regina-jones', 'rita-wheeler', 'river-ward',
    'rogue-amendiares', 'solomon-reed', 'songbird', 'takemura', 'viktor-vektor', 'wakako-okada'}) do M.TIER1[key] = true end

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

-- The default publisher: runtime/nearby-connections.json, rewritten in place (the two slots, then the conversation partners,
-- then the entity of each one that has an ID: a generic resident or archetype has no connection without its body).
local function publishFile(profiles, partners, entities, spawned)
    local function encode(list)
        local encoded = {}
        for _, key in ipairs(list or {}) do encoded[#encoded + 1] = json.encode(key) end
        return table.concat(encoded, ',')
    end
    local ids = {}
    for key, id in pairs(entities or {}) do ids[#ids + 1] = json.encode(key) .. ':' .. json.encode(id) end
    table.sort(ids)
    -- In place (one open): the file ships as an empty placeholder and the bridge ignores a partial read, so there is
    -- no temp file, remove or rename (a file deleted and renamed back is a new file under Mod Organizer 2).
    local file = io.open(PATH, 'wb')
    if not file then return false end
    local written = file:write('{"updated":' .. string.format('%.0f', os.time() * 1000) .. ',"profiles":[' .. encode(profiles)
        .. '],"partners":[' .. encode(partners) .. '],"spawned":[' .. encode(spawned) .. '],"entities":{' .. table.concat(ids, ',') .. '}}')
    local closed = file:close()
    return written and closed and true or false
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
        for _, entry in ipairs(active) do if not entry.spawned then result[#result + 1] = entry.key end end
        return result
    end
    local function spawnedKeys()
        local result = {}
        for _, entry in ipairs(active) do if entry.spawned then result[#result + 1] = entry.key end end
        return result
    end
    local function spawnedCount() return #spawnedKeys() end
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
        local list, partnerList, spawnedList = keys(), partnerKeys(), spawnedKeys()
        local ids, idSignature = entityIds()
        local signature = (#list > 0 or #partnerList > 0 or #spawnedList > 0) and table.concat(list, ',') .. '|' .. table.concat(partnerList, ',')
            .. '|' .. idSignature .. '|' .. table.concat(spawnedList, ',') or ''
        local now = wall()
        if not force and signature == lastSignature and lastPublish and now - lastPublish < cfg.heartbeat then return end
        -- An unchanged heartbeat writes in a frame no other heartbeat writes in (init.lua convaiHeartbeatSlot).
        local slot = convaiHeartbeatSlot
        if not force and signature == lastSignature and lastPublish and type(slot) == 'function' and not slot() then
            return 'slot'
        end
        if pcall(publish, list, partnerList, ids, spawnedList) then lastSignature, lastPublish = signature, now end
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

    -- A partner that is a spawned roster character (it came from the spawned lane, or options.spawned says so).
    local function isSpawnedPartner(partner)
        if partner.spawned == true then return true end
        if type(options.spawned) ~= 'function' then return false end
        local ok, value = pcall(options.spawned, partner)
        return ok and value == true
    end

    -- A partner that stops being one while it is still a spawned character standing near V goes straight back into the spawned
    -- lane, keeping its connection open: it is listed under 'spawned' in the same write that stops listing it under 'partners',
    -- and no cooldown applies (nothing is released, nothing is opened again). Only when the lane has a place; otherwise it is
    -- released as before. Returns true when it went back.
    local function backToLane(index, reason)
        if reason ~= 'no exchange' and reason ~= 'another partner' and reason ~= 'replaced' and reason ~= 'scene' then return false end
        local partner = partners[index]
        if not partner or spawnedCount() >= cfg.maxSpawned or not isSpawnedPartner(partner) or type(options.locate) ~= 'function' then return false end
        local ok, distance = pcall(options.locate, partner)
        if not ok or type(distance) ~= 'number' or distance > cfg.spawnedRadius then return false end
        table.remove(partners, index)
        active[#active + 1] = {key = partner.key, name = partner.key, since = clock, lastWanted = clock, spawned = true,
            reason = 'spawned', entity = type(partner.id) == 'string' and partner.id or nil}
        log('Auto-connect partner ' .. partner.key .. ' back to the spawned lane (' .. reason .. ')')
        return true
    end
    local function leavePartner(index, reason)
        if not backToLane(index, reason) then releasePartner(index, reason) end
    end

    -- The conversation partner(s): adopted while V talks to a world character, released when they part.
    local function updatePartners(context)
        local talking = context.talking
        if type(talking) == 'string' and talking ~= '' and not isParty(talking) then
            local partner = isPartner(talking)
            if not partner then
                partner = {key = talking, since = clock}
                table.insert(partners, 1, partner)
                -- The partner role replaces a slot or a spawned place it held: one connection, one owner.
                for index = #active, 1, -1 do
                    if active[index].key == talking then
                        if active[index].spawned then partner.spawned = true end
                        table.remove(active, index)
                    end
                end
                log('Auto-connect partner ' .. talking)
            end
            partner.lastExchange, partner.graceUntil, partner.awaySince = clock, nil, nil
            if context.talkingEntity ~= nil then partner.entity = context.talkingEntity end
            if type(context.talkingId) == 'string' then partner.id = context.talkingId end
            for _, other in ipairs(partners) do
                if other ~= partner and not other.graceUntil then other.graceUntil = clock + cfg.partnerGrace end
            end
        end
        -- Every character in the group round that is running counts as an exchange, not only the one V addressed: a partner who
        -- answers as another speaker has talked. The round's keys are asked only while there is a partner to refresh.
        if #partners > 0 and type(options.roundKeys) == 'function' then
            local ok, list = pcall(options.roundKeys)
            if ok and type(list) == 'table' then
                for _, key in ipairs(list) do
                    local member = isPartner(key)
                    if member then member.lastExchange, member.graceUntil = clock, nil end
                end
            end
        end
        table.sort(partners, function(a, b) return a.lastExchange > b.lastExchange end)
        while #partners > cfg.partnerMax do leavePartner(#partners, 'replaced') end
        for index = #partners, 1, -1 do
            local partner, reason, moved = partners[index], nil, false
            -- A scene (context.scene) ends the role of a world character. A spawned roster character (a follower mod's) keeps its
            -- connection: only a scripted scene proper (context.sceneReal) ends the role, and it goes back to the lane then; a
            -- choice hub, a dialogue flag or staged gameplay leaves the partner as it is.
            local scene = context.scene == true
            local spawnedHere = scene and isSpawnedPartner(partner)
            if spawnedHere then partner.spawned = true end
            if spawnedHere and context.sceneReal == true and partner.key ~= talking then moved = backToLane(index, 'scene') end
            if moved then
                -- back in the lane: nothing is released
            elseif partner.key ~= talking then
                if isParty(partner.key) then reason = 'joined the party'
                elseif scene and not spawnedHere then reason = 'scene'
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
            if reason then leavePartner(index, reason) end
        end
    end

    -- A gaze sample, about every 0.2 s: the character V is facing (a profile
    -- that is enabled and not already in the party), or nil. spawned: the adapter's cached classification says it is a spawned
    -- roster character, so the gaze wants it for the lane too (the scan that says so runs only once a second).
    function A.look(key, entity, name, dt, spawned)
        if not key or not entity then if next(look) ~= nil then look = {} end; return end
        if look.key ~= key or look.entity ~= entity then look = {key = key, entity = entity, name = name, dwell = 0} end
        look.dwell = look.dwell + (tonumber(dt) or 0)
        look.spawned = spawned == true
        look.seen = clock
    end

    -- The notice for the wait at the start of a conversation: shown whenever the
    -- character is not connected yet, with the setting on or off.
    function A.talkNotice(key, name)
        if not key or ready(key) then return nil end
        return ui.t('Preparing connection to {name}…', {name = name})
    end

    -- Is this character's conversation connection ready (the notice above would not show)? A holocall rings until it is.
    function A.ready(key) return key ~= nil and ready(key) == true end

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
            if next(look) ~= nil then look = {} end
            return
        end
        if context.worldReady ~= true then return end
        clock = clock + (tonumber(dt) or 0)
        if look.key and clock - (look.seen or 0) > cfg.lookExpiry then look = {} end
        updatePartners(context)

        local wanted, order = {}, {}
        local function want(key, name, priority, distance, entity, spawned)
            -- A partner already has its own connection; it never takes a slot as well.
            if isPartner(key) then return end
            if not wanted[key] then
                wanted[key] = {key = key, name = name, priority = priority, distance = distance or 0,
                    prominence = priority == 2 and prominence(key) or 0, entity = entity, spawned = spawned == true}
                order[#order + 1] = wanted[key]
            else
                if priority < wanted[key].priority then wanted[key].priority, wanted[key].entity = priority, entity end
                if spawned == true then wanted[key].spawned = true end
            end
        end
        if look.key and look.dwell >= cfg.gazeDwell then want(look.key, look.name, 1, 0, look.entity, look.spawned) end
        if not context.blocked and clock >= nextScan and type(options.scan) == 'function' then
            nextScan = clock + cfg.scanInterval
            local called, rows = pcall(options.scan, context.player, cfg.radius)
            if called and type(rows) == 'table' then
                for _, row in ipairs(rows) do want(row.key, row.name, 2, row.distance, row.entity, row.spawned) end
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
            -- A slot character the scan now reports as spawned (a gaze or an earlier scan put it in a slot first) moves to the lane:
            -- the same connection, no release, and a slot is free for someone else.
            if item and item.spawned and not entry.spawned and spawnedCount() < cfg.maxSpawned then
                entry.spawned, entry.reason = true, 'spawned'
                log('Auto-connect ' .. entry.key .. ' moved to the spawned lane')
            end
            -- While the world is blocked (combat, a scene, a call, a vehicle, a choice hub such as a follower mod's own menu) the scan
            -- is not asked, so nothing reports a spawned character that stands beside V: the lane keeps what it holds until the
            -- block ends and the next scan decides again.
            if entry.spawned and context.blocked then entry.lastWanted = clock end
            local idle, age = clock - entry.lastWanted, clock - entry.since
            -- A spawned character near V keeps its connection for as long as it is near: the lane is bounded (three, and the
            -- plan's count on the bridge), and the age limit would close it, and make V wait, while it still stands beside V.
            if entry.spawned then age = 0 end
            if idle > cfg.hold or age > cfg.maxAge then
                -- No cooldown for a spawned character: it was released because no scan reported it, and one that is reported
                -- again (V turned back, its body was made again) is warmed at once instead of after a wait that V would feel.
                if not entry.spawned then cooling[entry.key] = clock + (age > cfg.maxAge and cfg.ageCooldown or cfg.cooldown) end
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
                if not present and item.priority > 0 and (cooling[key] or 0) <= clock then
                    if item.spawned then
                        -- A spawned roster character has its own place (beside the two slots, no stagger: the bridge opens
                        -- connections one after another). A profile shared with a party member is still listed: one page.
                        if spawnedCount() < cfg.maxSpawned then
                            active[#active + 1] = {key = key, name = item.name, since = clock, lastWanted = clock, spawned = true,
                                reason = 'spawned', entity = type(item.entity) == 'string' and item.entity or nil}
                            log('Auto-connect warming ' .. key .. ' (spawned)')
                        end
                    elseif clock - lastStart >= cfg.stagger and not isParty(key) then
                        if #keys() >= cfg.maxWarm then
                            -- A looked-at character may take the place of the idlest one
                            -- that nobody wants right now.
                            local idlest
                            for index, entry in ipairs(active) do
                                if not entry.spawned and not wanted[entry.key]
                                    and (not idlest or entry.lastWanted < active[idlest].lastWanted) then idlest = index end
                            end
                            if item.priority == 1 and idlest then
                                cooling[active[idlest].key] = clock + cfg.cooldown
                                log('Auto-connect released ' .. active[idlest].key .. ' (replaced)')
                                table.remove(active, idlest)
                            end
                        end
                        if #keys() < cfg.maxWarm then
                            active[#active + 1] = {key = key, name = item.name, since = clock, lastWanted = clock,
                                reason = item.priority == 1 and 'gaze' or 'near', entity = type(item.entity) == 'string' and item.entity or nil}
                            lastStart = clock
                            log('Auto-connect warming ' .. key .. ' (' .. active[#active].reason .. ')')
                        end
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
    function A.spawned() return spawnedKeys() end
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
            rows[#rows + 1] = {key = entry.key, reason = entry.reason, since = entry.since, lastWanted = entry.lastWanted, spawned = entry.spawned == true}
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
