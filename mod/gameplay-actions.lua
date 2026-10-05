-- Conversation actions are capabilities captured by this game process. Provider
-- dialogue and an action packet alone cannot select an actor, car, waypoint or
-- target. One manual private request leases at most one drive offer and one
-- companion-tactic offer; the first matching packet consumes the whole lease.
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

local function normalizeOffer(offer)
    -- CET's JSON encoder rounds nonintegral native coordinates. Freeze exactly
    -- the representation sent to the bridge, retaining strict packet equality.
    local raw = json.encode(offer)
    if type(raw) ~= 'string' or #raw > MAX_PACKET then return nil end
    return json.decode(raw)
end

local function ownedOffer(offer, context)
    return type(offer) == 'table' and offer.available == true and type(offer.actor) == 'table'
        and offer.actor.id == context.entity and offer.actor.key == context.profileKey
end

local function offeredKind(offer, kind)
    if type(offer) ~= 'table' or type(offer.kinds) ~= 'table' or type(kind) ~= 'string' then return false end
    for _, value in ipairs(offer.kinds) do if value == kind then return true end end
    return false
end

function M.new(options)
    local Q = {}
    local lease, lastRaw, result, lastAdmission
    local clock = options.clock or function() return os.time() * 1000 end

    local function developerMode()
        if type(options.developerMode) ~= 'function' then return false end
        local ok, enabled = pcall(options.developerMode)
        return ok and enabled == true
    end

    local function capturedOffer(source, entity, context)
        if type(source) ~= 'function' then return nil end
        local ok, offer = pcall(source, entity)
        if not ok or not ownedOffer(offer, context) then return nil end
        local normalized, captured = pcall(options.normalizeOffer or normalizeOffer, offer)
        if not normalized or not ownedOffer(captured, context) then return nil end
        return captured
    end

    function Q.revoke(reason, requestId)
        if requestId and (not lease or lease.requestId ~= requestId) then return end
        if lease then result = {state = 'revoked', reason = reason or 'cancelled'} end
        lease = nil
    end

    -- Call only at actual manual request admission, never for warmup, phone,
    -- group prefetch or AI-authored text. Unavailable native offers stay absent.
    function Q.capture(context, source)
        if type(context) ~= 'table' then return false end
        context.chauffeurOffer, context.tacticOffer = nil, nil
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
            if lease then
                context.chauffeurOffer, context.tacticOffer = copy(lease.offer), copy(lease.tacticOffer)
                return true
            end
            return false
        end
        Q.revoke('new-conversation')
        lastAdmission = admission
        local drive = capturedOffer(options.offer, context.entity, context)
        local tactic = capturedOffer(options.tacticOffer, context.entity, context)
        if not drive and not tactic then return false end
        lease = {requestId = context.requestId, generation = context.generation, entity = context.entity,
            profileKey = context.profileKey, source = source, worldToken = world.worldToken,
            worldGeneration = world.generation, offer = copy(drive), tacticOffer = copy(tactic),
            expiresAt = clock() + MAX_LEASE_MS}
        context.chauffeurOffer, context.tacticOffer = copy(drive), copy(tactic)
        result = {state = 'available'}
        return true
    end

    local function report(state, reason, fallback)
        result = {state = state, reason = reason or fallback}
        if options.feedback and (result.state == 'rejected' or developerMode()) then
            pcall(options.feedback, result.state, result.reason)
        end
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
        local drive = packet.action == 'drive-to-waypoint' and lease.offer ~= nil
        local tactic = packet.action == 'companion-tactic' and lease.tacticOffer ~= nil
            and offeredKind(lease.tacticOffer, packet.tactic)
        if packet.version ~= 1 or not (drive or tactic)
            or type(packet.actionId) ~= 'string' or #packet.actionId < 1 or #packet.actionId > 240
            or packet.requestId ~= lease.requestId or packet.generation ~= lease.generation
            or packet.entity ~= lease.entity or packet.profileKey ~= lease.profileKey
            or packet.source ~= lease.source or packet.worldToken ~= lease.worldToken
            or packet.worldGeneration ~= lease.worldGeneration
            or type(packet.createdAt) ~= 'number' or type(packet.expiresAt) ~= 'number'
            or packet.createdAt ~= packet.createdAt or packet.expiresAt ~= packet.expiresAt
            or packet.createdAt > now + 5000 or packet.createdAt < now - MAX_LEASE_MS
            or packet.expiresAt <= now or packet.expiresAt > packet.createdAt + MAX_LEASE_MS
            or (drive and not equal(packet.offer, lease.offer))
            or (tactic and not equal(packet.tacticOffer, lease.tacticOffer)) then return end
        -- Consume before the native callback: even a throw after a side effect
        -- cannot execute this action twice. Native queue admission rechecks the
        -- actual managed copy and every other precondition.
        local admitted = lease
        lease = nil
        if drive then
            local called, accepted, reason = pcall(options.queue, admitted.offer.actor.serial,
                copy(admitted.offer), admitted.entity)
            report(called and accepted == true and 'queued' or 'rejected', called and reason or nil,
                'The driving request could not be queued.')
            return
        end
        if type(options.queueTactic) ~= 'function' then
            report('rejected', nil, 'That action is not available.'); return
        end
        local called, accepted, reason = pcall(options.queueTactic, packet.tactic,
            copy(admitted.tacticOffer), admitted.entity)
        report(called and accepted == true and 'queued' or 'rejected', called and reason or nil,
            'Your companion could not start that.')
    end

    function Q.inspect()
        return {pending = lease ~= nil, state = result and result.state or 'idle',
            reason = result and result.reason, drive = lease ~= nil and lease.offer ~= nil,
            tactic = lease ~= nil and lease.tacticOffer ~= nil}
    end

    return Q
end

return M
