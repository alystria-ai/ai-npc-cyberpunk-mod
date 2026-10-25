-- Conversation actions are capabilities captured by this game process. Provider
-- dialogue and an action packet alone cannot select an actor, car, waypoint or
-- target. One manual private request leases at most one drive offer, one
-- companion-tactic offer, one follow offer (a world character joining the
-- party) and one leave offer (a party member leaving); the first matching
-- packet consumes the whole lease. The first speaker of a manual group round
-- leases a leave offer only (docs/WORLD_COMPANIONS.md). An ordinary world NPC with none of those offers leases at most one
-- reaction offer instead (leave, call the police, attack; docs/NPC_REACTIONS.md, mod/npc-reactions.lua), private turns only.
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

-- A housing packet (mod/housemates.lua): {op = 'stay', apartment} for a flat the offer listed, {op = 'move-out'} when the offer allowed it,
-- {op = 'join', target = a listed member's entity | 'all'}.
local function offeredHome(offer, home)
    if type(offer) ~= 'table' or type(home) ~= 'table' then return false end
    if home.op == 'stay' then
        for _, apartment in ipairs(offer.apartments or {}) do if apartment.id == home.apartment then return true end end
        return false
    elseif home.op == 'move-out' then return offer.moveOut == true
    elseif home.op == 'join' then
        local members = offer.members or {}
        if home.target == 'all' then return #members >= 1 end
        for _, member in ipairs(members) do if member.id == home.target then return true end end
    end
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
    local lastRevision, lastReadAt = nil, 0
    -- The native plugin's revision of a file this mod reads (mod/native-core.lua: a number that changes when the bytes change), or nil
    -- without the plugin, before its first read of the file, or while the file is missing.
    local function revisionOf(name)
        local source = options.revision or (type(convaiNative) == 'table' and convaiNative.revision) or nil
        if not source then return nil end
        local ok, value = pcall(source, name)
        return ok and type(value) == 'number' and value > 0 and value or nil
    end
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
        context.reactionOffer = copy(from.reactionOffer)
        context.homeOffer = copy(from.homeOffer)
    end

    -- The one place a reaction offer's end is written when it ends for a reason that is not the ordinary one (the next message, or its own
    -- 125 s running out): a reply that failed or never came, a menu, a changed world. A silent end was why a live test showed offers and nothing else.
    local ORDINARY_END = {['new-conversation'] = true, ['lease-expired'] = true}
    local function logReaction(line)
        if type(options.log) == 'function' then pcall(options.log, line) end
    end

    function Q.revoke(reason, requestId)
        if requestId and (not lease or lease.requestId ~= requestId) then return end
        if lease then
            result = {state = 'revoked', reason = reason or 'cancelled'}
            if lease.reactionOffer ~= nil and not ORDINARY_END[reason or 'cancelled'] then
                logReaction('NPC reaction offer ended before it was used: ' .. tostring(reason or 'cancelled'))
            end
        end
        lease = nil
    end
    Q.options = options

    -- Call only at actual manual request admission, never for warmup, phone,
    -- group prefetch or AI-authored text. Unavailable native offers stay absent.
    -- Group sources admit only the first speaker of a manual round, and only a
    -- leave offer: V may send one or more companions of that round away.
    function Q.capture(context, source)
        if type(context) ~= 'table' then return false end
        context.chauffeurOffer, context.tacticOffer, context.tacticUnavailable = nil, nil, nil
        context.followOffer, context.leaveOffer, context.followUnavailable = nil, nil, nil
        context.driveUnavailable, context.reactionOffer, context.homeOffer = nil, nil, nil
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
        if leave and (type(leave.members) ~= 'table' or #leave.members < 1 or #leave.members > 12) then leave = nil end
        -- An ordinary world NPC's reaction (docs/NPC_REACTIONS.md): only a private conversation, and only for a person with no
        -- companion offer at all.
        local reaction
        if private and not drive and not tactic and not follow and not leave then
            reaction = capturedOffer(options.reactionOffer, context.entity, context)
            if reaction and (type(reaction.kinds) ~= 'table' or #reaction.kinds < 1 or #reaction.kinds > 3) then reaction = nil end
        end
        -- A housing offer (mod/housemates.lua): V's flats to move into, the housemates V may call along, and moving out. Private turns
        -- carry the apartments; the first speaker of a group round carries only the audience.
        local home
        if private then home = capturedOffer(options.homeOffer, context.entity, context)
        elseif group then home = capturedOffer(options.groupHomeOffer, context.entity, context) end
        if home and (type(home.apartments) ~= 'table' or #home.apartments > 5 or type(home.members) ~= 'table' or #home.members > 12) then home = nil end
        -- A housing offer is a companion's: it replaces an ordinary person's reaction offer.
        if home then reaction = nil end
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
        if not drive and not tactic and not follow and not leave and not reaction and not home then return false end
        lease = {requestId = context.requestId, generation = context.generation, entity = context.entity,
            profileKey = context.profileKey, source = source, worldToken = world.worldToken,
            worldGeneration = world.generation, offer = copy(drive), tacticOffer = copy(tactic),
            followOffer = copy(follow), leaveOffer = copy(leave), reactionOffer = copy(reaction), homeOffer = copy(home),
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
        if now >= lease.expiresAt then Q.revoke('lease-expired'); return end
        if not gameplayReady or not worldMatches(lease, options.world()) then
            Q.revoke(gameplayReady and 'world-changed' or 'world-not-ready'); return
        end
        -- With the native plugin the packet file is not opened while its revision (one number, no disk access) is the one of the last
        -- read: that read left lastRaw as it is, and an unchanged text returns below anyway. A read at least once a second remains,
        -- and without the plugin (no revision) every update reads as before.
        local revision = revisionOf('companion-actions.json')
        local wall = os.clock()
        if revision and revision == lastRevision and wall >= lastReadAt and wall - lastReadAt < 1 then return end
        local readOk, raw = pcall(options.read or readPacket)
        if not readOk or type(raw) ~= 'string' then lastRevision = nil; return end
        lastRevision, lastReadAt = revision, wall
        if raw == lastRaw then return end
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
        local reaction = packet.action == 'npc-reaction' and lease.reactionOffer ~= nil
            and offeredKind(lease.reactionOffer, packet.reaction)
        local homeAction = packet.action == 'companion-home' and lease.homeOffer ~= nil and offeredHome(lease.homeOffer, packet.home)
        -- The first rule this packet breaks (nil: none). The reason is written for an ordinary NPC's reaction only, once per packet.
        local fault
        if packet.version ~= 1 then fault = 'version'
        elseif not (drive or tactic or follow or leave or reaction or homeAction) then fault = 'not-offered'
        elseif type(packet.actionId) ~= 'string' or #packet.actionId < 1 or #packet.actionId > 240 then fault = 'action-id'
        elseif packet.requestId ~= lease.requestId or packet.generation ~= lease.generation then fault = 'other-request'
        elseif packet.entity ~= lease.entity or packet.profileKey ~= lease.profileKey then fault = 'other-person'
        elseif packet.source ~= lease.source then fault = 'source'
        elseif packet.worldToken ~= lease.worldToken or packet.worldGeneration ~= lease.worldGeneration then fault = 'other-world'
        elseif type(packet.createdAt) ~= 'number' or type(packet.expiresAt) ~= 'number'
            or packet.createdAt ~= packet.createdAt or packet.expiresAt ~= packet.expiresAt then fault = 'times'
        elseif packet.createdAt > now + 5000 or packet.createdAt < now - MAX_LEASE_MS then fault = 'clock'
        elseif packet.expiresAt <= now or packet.expiresAt > packet.createdAt + MAX_LEASE_MS then fault = 'expired'
        elseif (drive and not equal(packet.offer, lease.offer))
            or (tactic and not equal(packet.tacticOffer, lease.tacticOffer))
            or (follow and not equal(packet.followOffer, lease.followOffer))
            or (leave and not equal(packet.leaveOffer, lease.leaveOffer))
            or (reaction and not equal(packet.reactionOffer, lease.reactionOffer))
            or (homeAction and not equal(packet.homeOffer, lease.homeOffer)) then fault = 'offer-differs' end
        if fault then
            if packet.action == 'npc-reaction' then logReaction('NPC reaction packet refused: ' .. fault) end
            return
        end
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
        if reaction then
            -- An ordinary NPC's reaction says nothing on screen, accepted or not: the log line of the service is its record.
            local called, accepted, why = pcall(options.queueReaction or function() return false, 'not-available' end, packet.reaction,
                copy(admitted.reactionOffer), admitted.entity, admitted.requestId)
            result = {state = called and accepted == true and 'queued' or 'rejected', reason = called and why or nil}
            if result.state == 'rejected' then
                logReaction('NPC reaction hand-over rejected: ' .. tostring(called and why or ('error: ' .. tostring(accepted):sub(1, 120))))
            end
            return
        end
        if homeAction then
            if type(options.queueHome) ~= 'function' then report('rejected', nil, 'That action is not available.'); return end
            local called, accepted, reason = pcall(options.queueHome, copy(packet.home), copy(admitted.homeOffer), admitted.entity,
                admitted.requestId, admitted.group)
            report(called and accepted == true and 'queued' or 'rejected', called and reason or nil, 'That action is not available.')
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
            leave = lease ~= nil and lease.leaveOffer ~= nil, reaction = lease ~= nil and lease.reactionOffer ~= nil,
            home = lease ~= nil and lease.homeOffer ~= nil,
            followUnavailable = lastAdvisory,
            tacticUnavailable = lastTacticAdvisory, driveUnavailable = lastDriveAdvisory}
    end

    return Q
end

return M
