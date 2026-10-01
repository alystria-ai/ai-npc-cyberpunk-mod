-- Conversation actions are capabilities captured by this game process. Provider
-- dialogue and an action packet alone cannot select an actor, car or waypoint.
local M = {}
local MAX_PACKET, MAX_LEASE_MS = 16384, 125000

local function copy(value, depth)
    if type(value) ~= 'table' then return value end
    if (depth or 0) > 8 then return nil end
    local result = {}
    for key, item in pairs(value) do result[key] = copy(item, (depth or 0) + 1) end
    return result
end

local function equal(a, b, depth)
    if type(a) ~= type(b) then return false end
    if type(a) ~= 'table' then return a == b end
    if (depth or 0) > 8 then return false end
    for key, item in pairs(a) do if not equal(item, b[key], (depth or 0) + 1) then return false end end
    for key in pairs(b) do if a[key] == nil then return false end end
    return true
end

local function worldMatches(lease, world)
    return world and world.ready == true and world.worldToken == lease.worldToken
        and world.generation == lease.worldGeneration
end

local function readPacket()
    local file = io.open('runtime/companion-actions.json', 'rb')
    if not file then return nil end
    local raw = file:read(MAX_PACKET + 1); file:close()
    return raw
end

function M.new(options)
    local Q = {}
    local lease, lastRaw, result, lastAdmission
    local clock = options.clock or function() return os.time() * 1000 end

    function Q.revoke(reason, requestId)
        if requestId and (not lease or lease.requestId ~= requestId) then return end
        if lease then result = {state = 'revoked', reason = reason or 'cancelled'} end
        lease = nil
    end

    -- Call only at actual manual request admission, never for warmup, phone,
    -- group prefetch or AI-authored text. Unavailable native offers stay absent.
    function Q.capture(context, source)
        if type(context) ~= 'table' then return false end
        context.chauffeurOffer = nil
        if (source ~= 'private-text' and source ~= 'private-voice') or context.group or context.reaction
            or type(context.requestId) ~= 'string' or type(context.entity) ~= 'string'
            or type(context.profileKey) ~= 'string' or type(context.generation) ~= 'number' then
            Q.revoke('ineligible-conversation'); return false
        end
        local world = options.world()
        if not world or world.ready ~= true then Q.revoke('world-unavailable'); return false end
        local admission = table.concat({world.worldToken, tostring(world.generation), context.requestId,
            tostring(context.generation), context.entity, context.profileKey, source}, '\n')
        if admission == lastAdmission then
            if lease then context.chauffeurOffer = copy(lease.offer); return true end
            return false
        end
        Q.revoke('new-conversation')
        lastAdmission = admission
        local ok, offer = pcall(options.offer, context.entity)
        if not ok or type(offer) ~= 'table' or offer.available ~= true or type(offer.actor) ~= 'table'
            or offer.actor.id ~= context.entity or offer.actor.key ~= context.profileKey then return false end
        lease = {requestId = context.requestId, generation = context.generation, entity = context.entity,
            profileKey = context.profileKey, source = source, worldToken = world.worldToken,
            worldGeneration = world.generation, offer = copy(offer), expiresAt = clock() + MAX_LEASE_MS}
        context.chauffeurOffer = copy(offer)
        result = {state = 'available'}
        return true
    end

    function Q.update(gameplayReady)
        if not lease then return end
        local now = clock()
        if not gameplayReady or not worldMatches(lease, options.world()) or now >= lease.expiresAt then
            Q.revoke('world-or-request-expired'); return
        end
        local readOk, raw = pcall(options.read or readPacket)
        if not readOk or type(raw) ~= 'string' or raw == lastRaw then return end
        lastRaw = raw
        if #raw > MAX_PACKET then return end
        local decoded, packet = pcall(options.decode or json.decode, raw)
        if not decoded or type(packet) ~= 'table' then return end
        if packet.version ~= 1 or packet.action ~= 'drive-to-waypoint'
            or type(packet.actionId) ~= 'string' or #packet.actionId < 1 or #packet.actionId > 240
            or packet.requestId ~= lease.requestId or packet.generation ~= lease.generation
            or packet.entity ~= lease.entity or packet.profileKey ~= lease.profileKey
            or packet.source ~= lease.source or packet.worldToken ~= lease.worldToken
            or packet.worldGeneration ~= lease.worldGeneration
            or type(packet.createdAt) ~= 'number' or type(packet.expiresAt) ~= 'number'
            or packet.createdAt ~= packet.createdAt or packet.expiresAt ~= packet.expiresAt
            or packet.createdAt > now + 5000 or packet.createdAt < now - MAX_LEASE_MS
            or packet.expiresAt <= now or packet.expiresAt > packet.createdAt + MAX_LEASE_MS
            or not equal(packet.offer, lease.offer) then return end
        -- Consume before the native callback: even a throw after a side effect
        -- cannot execute this action twice. Native queue admission rechecks the
        -- actual managed copy, summoned owned car, seats and selected waypoint.
        local admitted = lease
        lease = nil
        local called, accepted, reason = pcall(options.queue, admitted.offer.actor.serial,
            copy(admitted.offer), admitted.entity)
        result = {state = called and accepted == true and 'queued' or 'rejected',
            reason = called and reason or 'The driving request could not be queued.'}
        if options.feedback then pcall(options.feedback, result.state, result.reason) end
    end

    function Q.inspect()
        return {pending = lease ~= nil, state = result and result.state or 'idle',
            reason = result and result.reason}
    end

    return Q
end

return M
