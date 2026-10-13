-- Conversation actions are capabilities captured by this game process. Provider
-- dialogue and an action packet alone cannot select an actor, car, waypoint or
-- target. One manual private request leases at most one drive offer, one
-- companion-tactic offer, one follow offer (a world character joining the
-- party) and one leave offer (a party member leaving); the first matching
-- packet consumes the whole lease. The first speaker of a manual group round
-- leases a leave offer only (docs/WORLD_COMPANIONS.md).
local M = {}
local MAX_PACKET, MAX_LEASE_MS = 16384, 125000
-- Why a world character cannot follow V now. Only these codes reach the bridge,
-- which turns them into a short instruction to decline in character.
local FOLLOW_UNAVAILABLE = {quest = true, scene = true, combat = true, police = true, hostile = true,
    working = true, vehicle = true, busy = true, ['already-here'] = true, unavailable = true}
M.FOLLOW_UNAVAILABLE = FOLLOW_UNAVAILABLE
-- Why the game cannot let a companion drive V now (the chauffeur offer's own code -> the few codes the bridge knows). A text-route
-- character (Mistral, the local AI) uses it to say what V has to do first instead of promising a ride; nothing is leased for it.
local DRIVE_UNAVAILABLE = {['player-driving'] = 'player-driving', ['player-seated'] = 'player-seated',
    ['no-waypoint'] = 'no-waypoint', ['no-owned-car'] = 'no-car', ['ambiguous-owned-car'] = 'no-car',
    ['car-distant'] = 'no-car', ['car-arriving'] = 'no-car', ['car-moving'] = 'car-moving', combat = 'combat',
    ['transport-busy'] = 'busy', ['autodrive-active'] = 'busy', ['driver-occupied'] = 'busy',
    ['no-passenger-seat'] = 'busy', ['actor-seated'] = 'busy', ['actor-unavailable'] = 'busy',
    ['driving-unavailable'] = 'busy', ['world-unavailable'] = 'busy'}
M.DRIVE_UNAVAILABLE = DRIVE_UNAVAILABLE

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

-- A leave packet names one offered member by entity, or 'all'.
local function offeredMember(offer, target)
    if type(offer) ~= 'table' or type(offer.members) ~= 'table' or type(target) ~= 'string' then return false end
    if target == 'all' then return #offer.members >= 1 end
    for _, member in ipairs(offer.members) do if member.id == target then return true end end
    return false
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

    -- Returns the normalized available offer, or nil plus the raw answer so an
    -- unavailable follow can still explain itself without leasing anything.
    local function capturedOffer(source, entity, context)
        if type(source) ~= 'function' then return nil end
        local ok, offer = pcall(source, entity, context)
        if not ok then return nil end
        if not ownedOffer(offer, context) then return nil, offer end
        local normalized, captured = pcall(options.normalizeOffer or normalizeOffer, offer)
        if not normalized or not ownedOffer(captured, context) then return nil end
        return captured
    end
    local lastAdvisory, lastTacticAdvisory, lastDriveAdvisory

    local function assign(context, from)
        context.chauffeurOffer, context.tacticOffer = copy(from.offer), copy(from.tacticOffer)
        context.followOffer, context.leaveOffer = copy(from.followOffer), copy(from.leaveOffer)
    end

    function Q.revoke(reason, requestId)
        if requestId and (not lease or lease.requestId ~= requestId) then return end
        if lease then result = {state = 'revoked', reason = reason or 'cancelled'} end
        lease = nil
    end

    -- Call only at actual manual request admission, never for warmup, phone,
    -- group prefetch or AI-authored text. Unavailable native offers stay absent.
    -- Group sources admit only the first speaker of a manual round, and only a
    -- leave offer: V may send one or more companions of that round away.
    function Q.capture(context, source)
        if type(context) ~= 'table' then return false end
        context.chauffeurOffer, context.tacticOffer, context.tacticUnavailable = nil, nil, nil
        context.followOffer, context.leaveOffer, context.followUnavailable = nil, nil, nil
        context.driveUnavailable = nil
        local private = source == 'private-text' or source == 'private-voice'
        local group = source == 'group-text' or source == 'group-voice'
        if not (private or group) or (private and context.group ~= nil) or context.reaction
            or (group and (type(context.group) ~= 'table' or context.group.index ~= 1
                or type(context.group.id) ~= 'string'))
            or type(context.requestId) ~= 'string' or type(context.entity) ~= 'string'
            or type(context.profileKey) ~= 'string' or type(context.generation) ~= 'number' then
            Q.revoke('ineligible-conversation'); return false
        end
        local world = options.world()
        if not world or world.ready ~= true then Q.revoke('world-unavailable'); return false end
        local admission = table.concat({world.worldToken, tostring(world.generation), context.requestId,
            tostring(context.generation), context.entity, context.profileKey, source}, '\n')
        if admission == lastAdmission then
            context.followUnavailable, context.tacticUnavailable = lastAdvisory, lastTacticAdvisory
            context.driveUnavailable = lastDriveAdvisory
            if lease then assign(context, lease); return true end
            return false
        end
        Q.revoke('new-conversation')
        lastAdmission, lastAdvisory, lastTacticAdvisory, lastDriveAdvisory = admission, nil, nil, nil
        local drive, tactic, follow, refusal, tacticRefusal, driveRefusal
        if private then
            drive, driveRefusal = capturedOffer(options.offer, context.entity, context)
            tactic, tacticRefusal = capturedOffer(options.tacticOffer, context.entity, context)
            follow, refusal = capturedOffer(options.followOffer, context.entity, context)
        end
        local leave = capturedOffer(options.leaveOffer, context.entity, context)
        if leave and (type(leave.members) ~= 'table' or #leave.members < 1 or #leave.members > 3) then leave = nil end
        -- A follow the game refuses carries only its reason code: no lease, no action.
        if not follow and type(refusal) == 'table' and refusal.available == false
            and FOLLOW_UNAVAILABLE[refusal.reason] then
            lastAdvisory = refusal.reason
            context.followUnavailable = refusal.reason
        end
        -- A ride the game cannot give: only the code of why (a standing car, a map destination, V out of the driver seat).
        if not drive and type(driveRefusal) == 'table' and driveRefusal.available == false
            and DRIVE_UNAVAILABLE[driveRefusal.code] then
            lastDriveAdvisory = DRIVE_UNAVAILABLE[driveRefusal.code]
            context.driveUnavailable = lastDriveAdvisory
        end
        -- No valid target: the bridge learns it so the character does not claim to attack anyone.
        if not tactic and type(tacticRefusal) == 'table' and tacticRefusal.available == false
            and tacticRefusal.code == 'no-target' then
            lastTacticAdvisory = 'no-target'
            context.tacticUnavailable = 'no-target'
        end
        if not drive and not tactic and not follow and not leave then return false end
        lease = {requestId = context.requestId, generation = context.generation, entity = context.entity,
            profileKey = context.profileKey, source = source, worldToken = world.worldToken,
            worldGeneration = world.generation, offer = copy(drive), tacticOffer = copy(tactic),
            followOffer = copy(follow), leaveOffer = copy(leave),
            group = group and context.group.id or nil, expiresAt = clock() + MAX_LEASE_MS}
        assign(context, lease)
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
        local follow = packet.action == 'companion-follow' and lease.followOffer ~= nil
        local leave = packet.action == 'companion-leave' and lease.leaveOffer ~= nil
            and offeredMember(lease.leaveOffer, packet.leave)
        if packet.version ~= 1 or not (drive or tactic or follow or leave)
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
            or (tactic and not equal(packet.tacticOffer, lease.tacticOffer))
            or (follow and not equal(packet.followOffer, lease.followOffer))
            or (leave and not equal(packet.leaveOffer, lease.leaveOffer)) then return end
        -- Consume before the native callback: even a throw after a side effect
        -- cannot execute this action twice. Native queue admission rechecks the
        -- actual managed copy and every other precondition.
        local admitted = lease
        lease = nil
        if drive then
            local called, accepted, reason = pcall(options.queue, admitted.offer.actor.serial,
                copy(admitted.offer), admitted.entity)
            -- A queued drive has no text of its own: the reason stays empty.
            local driveQueued = called and accepted == true
            report(driveQueued and 'queued' or 'rejected', called and reason or nil,
                driveQueued and '' or 'The driving request could not be queued.')
            return
        end
        if follow or leave then
            local queue = follow and options.queueFollow or options.queueLeave
            if type(queue) ~= 'function' then report('rejected', nil, 'That action is not available.'); return end
            local called, accepted, reason
            if follow then
                called, accepted, reason = pcall(queue, copy(admitted.followOffer), admitted.entity, admitted.requestId)
            else
                called, accepted, reason = pcall(queue, packet.leave, copy(admitted.leaveOffer), admitted.entity,
                    admitted.requestId, admitted.group)
            end
            report(called and accepted == true and 'queued' or 'rejected', called and reason or nil,
                'That action is not available.')
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
            tactic = lease ~= nil and lease.tacticOffer ~= nil, follow = lease ~= nil and lease.followOffer ~= nil,
            leave = lease ~= nil and lease.leaveOffer ~= nil, followUnavailable = lastAdvisory,
            tacticUnavailable = lastTacticAdvisory, driveUnavailable = lastDriveAdvisory}
    end

    return Q
end

return M
