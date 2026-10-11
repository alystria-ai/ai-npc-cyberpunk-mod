-- Companion tactics against the target chosen from the game's own tagging: Fight, and Distract with three
-- endings (return to the planning spot, attack the target, rejoin V).
--
-- Ownership: while a tactic runs, this module supplies the movement decision for
-- exactly one managed copy through companions.tactics (owns/decide); the
-- companion's actuator still issues every native command, so there is one owner
-- per movement command. Fighting releases movement to native combat AI.
-- Conversation turns go through the mod's ordinary request/speech/subtitle/
-- lip-sync path as automatic 'distraction' turns, five lines in strict order.
-- Every native change (hostility, perception, the target's hold/look) is
-- recorded and restored on completion or cancellation; world teardown forgets
-- handles without native calls.
local M = {}
local TURNS = 5
local KINDS = {fight = true, ['distract-return'] = true, ['distract-fight'] = true, ['distract-rejoin'] = true}
local DEFAULTS = {
    maxOfferDistance = 60, talkDistance = 1.7, arriveWithin = 2.4, approachTimeout = 75,
    faceTimeout = 2.5, fightApproach = 8, fightStartTimeout = 25, fightTimeout = 180,
    returnArrive = 1.6, returnTimeout = 90, waitForV = 6, waitTimeout = 120,
    turnTimeout = 45, leaseEvery = 2, turnRetries = 1, offerTtl = 125,
}

local function copy(value)
    if type(value) ~= 'table' then return value end
    local result = {}
    for key, item in pairs(value) do result[key] = copy(item) end
    return result
end
local function ground(a, b)
    if not a or not b then return math.huge end
    return math.sqrt((a.x - b.x)^2 + (a.y - b.y)^2)
end
local function toward(from, to, stop)
    local dx, dy = from.x - to.x, from.y - to.y
    local length = math.sqrt(dx * dx + dy * dy)
    if length < 0.01 then dx, dy, length = 1, 0, 1 end
    return {x = to.x + dx / length * stop, y = to.y + dy / length * stop, z = to.z}
end
local function clipLine(text)
    if type(text) ~= 'string' then return nil end
    text = text:gsub('[%c]', ' '):gsub('^%s+', ''):gsub('%s+$', '')
    if text == '' then return nil end
    if #text > 400 then text = text:sub(1, 397) .. '...' end
    return text
end

-- GetBodyType returns a CName; tostring() of one prints 'ToCName{ hash_lo = ..., hash_hi = ... --[[ WomanAverage --]] }'.
-- This gives the plain name ('WomanAverage'), or '' when there is none.
local function bodyName(value)
    if value == nil then return '' end
    if type(value) == 'string' then return value end
    if type(NameToString) == 'function' then
        local ok, name = pcall(NameToString, value)
        if ok and type(name) == 'string' and name ~= '' and name ~= 'None' then return name end
    end
    local raw = tostring(value)
    return raw:match('%-%-%[%[%s*(.-)%s*%-%-%]%]') or raw
end

-- CET adapter for the native effects this module owns.
function M.nativeAdapter()
    local N = {}
    local function attitude(name) return Enum.new('EAIAttitude', name) end
    local function attitudeName(from, to)
        local text = tostring(from:GetAttitudeAgent():GetAttitudeTowards(to:GetAttitudeAgent()))
        for _, name in ipairs({'AIA_Hostile', 'AIA_Neutral', 'AIA_Friendly'}) do
            if text:find(name, 1, true) then return name end
        end
        return nil
    end
    local function persistenceSource()
        local record = TweakDBInterface.GetAIThreatPersistenceSourceRecord(TweakDBID.new('AIThreatPersistenceSource.CommandInjectThreat'))
        return record and record:EnumValue() or nil
    end
    function N.key(object) return tostring(object:GetEntityID().hash) end
    function N.position(object) local p = object:GetWorldPosition(); return {x = p.x, y = p.y, z = p.z} end
    function N.alive(npc)
        return npc ~= nil and npc:IsAttached() and not npc:IsDeadNoStatPool() and not ScriptedPuppet.IsDefeated(npc)
    end
    function N.inCombat(npc) return NPCPuppet.IsInCombat(npc) == true end
    function N.playerInCombat(player) return player:IsInCombat() == true end
    function N.playerMounted(player) return player:GetMountedVehicle() ~= nil end
    function N.hostileToPlayer(npc, player) return attitudeName(npc, player) == 'AIA_Hostile' end
    function N.name(npc) return tostring(npc:GetTweakDBFullDisplayName(true) or 'NPC') end
    function N.bodyType(npc) return bodyName(npc:GetBodyType()) end
    -- Fight: agent-level hostility in both directions (never the whole attitude
    -- group, which would turn V's group against everyone of the target's group),
    -- then a persistent hostile threat so the companion's combat AI engages.
    function N.startFight(companion, target)
        local receipt = {companionToTarget = attitudeName(companion, target), targetToCompanion = attitudeName(target, companion)}
        companion:GetAttitudeAgent():SetAttitudeTowards(target:GetAttitudeAgent(), attitude('AIA_Hostile'))
        target:GetAttitudeAgent():SetAttitudeTowards(companion:GetAttitudeAgent(), attitude('AIA_Hostile'))
        local tracker = companion:GetTargetTrackerComponent()
        tracker:AddThreat(target, true, target:GetWorldPosition(), 1.0, -1.0, true)
        local source = persistenceSource()
        if source then tracker:SetThreatPersistence(target, true, source); receipt.persistence = source end
        return receipt
    end
    function N.stopFight(receipt, companion, target)
        if receipt.persistence then companion:GetTargetTrackerComponent():SetThreatPersistence(target, false, receipt.persistence) end
        if receipt.companionToTarget then companion:GetAttitudeAgent():SetAttitudeTowards(target:GetAttitudeAgent(), attitude(receipt.companionToTarget)) end
        if receipt.targetToCompanion then target:GetAttitudeAgent():SetAttitudeTowards(companion:GetAttitudeAgent(), attitude(receipt.targetToCompanion)) end
    end
    -- The target stops (civilians/crowd outside a workspot, like the mod's own
    -- conversation focus) and looks at the companion while they talk.
    function N.engage(target, companion)
        local handle = {}
        local workspots = Game.GetWorkspotSystem()
        local inWorkspot = workspots and workspots:IsActorInWorkspot(target)
        if (target:IsCrowd() or target:IsCharacterCivilian()) and not inWorkspot then
            local hold = NewObject('AIHoldPositionCommand'); hold.duration = 60
            handle.hold = hold
            target:GetAIControllerComponent():SendCommand(hold)
        end
        local look = LookAtAddEvent.new()
        look:SetEntityTarget(companion, CName.new('Head'), Vector4.new(0, 0, 0, 0))
        look:SetStyle(Enum.new('animLookAtStyle', 'Normal'))
        look.bodyPart = CName.new('Eyes')
        look.request.limits.softLimitDegrees = 360
        look.request.limits.hardLimitDegrees = 270
        look.request.limits.backLimitDegrees = 210
        handle.look = look
        target:QueueEvent(look)
        return handle
    end
    function N.release(handle, target)
        if handle.look then LookAtRemoveEvent.QueueRemoveLookatEvent(target, handle.look) end
        if handle.hold then
            local ai = target:GetAIControllerComponent()
            local state = tostring(ai:GetCommandState(handle.hold))
            if state:find('Executing', 1, true) then ai:StopExecutingCommand(handle.hold, true)
            elseif state:find('Enqueued', 1, true) then ai:CancelCommand(handle.hold) end
        end
    end
    return N
end

function M.new(options)
    options = options or {}
    local T, env, native = {}, options.env or {}, options.native or M.nativeAdapter()
    local perception = options.perception or dofile('tactic-perception.lua').new({
        skip = function(npc) return type(env.protected) == 'function' and env.protected(npc) == true end})
    local settings = {}
    for key, value in pairs(DEFAULTS) do settings[key] = options[key] or value end
    local active, offers, sequence, clock, last = nil, {}, 0, 0, nil

    local function get(fn, ...)
        if type(fn) ~= 'function' then return nil end
        local ok, value = pcall(fn, ...)
        if ok then return value end
    end
    local function log(line) if env.log then pcall(env.log, 'Companion tactic: ' .. line) end end
    local function feedback(message) if env.feedback and message then pcall(env.feedback, message) end end
    local function now() return get(env.now) or os.time() * 1000 end
    local function lease(requestId, valid, playbackAt)
        if env.writeLease and requestId then pcall(env.writeLease, requestId, valid, playbackAt) end
    end

    local function op(kind, goal, gait, finish, face)
        local a = active
        local current = a.operation
        if not current or current.kind ~= kind or current.phase ~= a.phase or current.finish ~= finish then
            a.tickets = a.tickets + 1
            current = {ticket = 'tactic-' .. a.id .. '-' .. a.tickets, kind = kind, phase = a.phase}
            a.operation = current
        end
        current.goal = goal and copy(goal) or nil
        current.gait, current.finish, current.face = gait, finish, face
        return current
    end

    local function enter(phase, reason)
        if active.phase ~= phase then
            active.phase, active.since = phase, clock
            active.trace[#active.trace + 1] = {at = clock, phase = phase, reason = reason}
            if #active.trace > 24 then table.remove(active.trace, 1) end
            log(active.kind .. ' ' .. phase .. (reason and (': ' .. reason) or ''))
        end
    end

    local function endConversationTurn(a)
        local turn = a.convo and a.convo.current
        if turn then
            lease(turn.requestId, false)
            if turn.requestId and env.stopTurn then pcall(env.stopTurn, turn.requestId) end
            a.convo.current = nil
        end
    end

    local function releaseDistraction(a)
        if a.engaged then
            local handle = a.engaged; a.engaged = nil
            if get(native.alive, a.target) then pcall(native.release, handle, a.target) end
        end
        if perception.active() then
            local restored = perception.restore()
            log('perception restored on ' .. tostring(restored) .. ' NPCs')
        end
    end

    local function releaseFight(a)
        if not a.fightReceipt then return end
        local receipt = a.fightReceipt; a.fightReceipt = nil
        -- A defeated target needs nothing back; a living one gets its attitudes.
        if get(native.alive, a.target) and get(native.alive, a.companion) then
            pcall(native.stopFight, receipt, a.companion, a.target)
        end
    end

    local function finish(reason, message)
        local a = active
        if not a then return end
        endConversationTurn(a)
        releaseDistraction(a)
        releaseFight(a)
        active = nil
        last = {id = a.id, kind = a.kind, ending = a.ending, result = reason, phase = a.phase,
            lines = #(a.convo and a.convo.lines or {}), trace = a.trace}
        log('finished (' .. tostring(reason) .. ')')
        if message then feedback(message) end
    end

    function T.cancel(reason, message) if active then finish(reason or 'cancelled', message) end end

    -- Forget every handle without native calls (world teardown).
    function T.abandon()
        if active and active.convo and active.convo.current then lease(active.convo.current.requestId, false) end
        active, offers = nil, {}
        perception.abandon()
    end

    local function actorFor(entity)
        local actor = get(env.actor, entity)
        if type(actor) ~= 'table' or not actor.npc or type(actor.serial) ~= 'number' then return nil end
        return actor
    end

    local function converses(target)
        local key, name, body = nil, nil, nil
        if env.identify then
            local ok, a, b, c = pcall(env.identify, target)
            if ok then key, name, body = a, b, c end
        end
        if not key or not get(env.converses, key) then return nil end
        return {profileKey = key, name = name, bodyType = body}
    end

    -- Called at manual private request admission (gameplay-actions capture).
    function T.offer(entity)
        local player = get(env.player)
        if not player then return {available = false, reason = 'Player unavailable'} end
        if get(native.playerMounted, player) then return {available = false, reason = 'V is in a vehicle'} end
        local actor = actorFor(entity)
        if not actor then return {available = false, reason = 'Not a ready companion on foot'} end
        local target, info = nil, nil
        if env.marked then
            local ok, npc, detail = pcall(env.marked, player)
            if ok then target, info = npc, detail end
        end
        if not target or not info or not info.id then return {available = false, reason = 'No target'} end
        if info.id == entity or not get(native.alive, target) then return {available = false, reason = 'Target unavailable'} end
        local targetAt, playerAt = get(native.position, target), get(native.position, player)
        local gap = targetAt and playerAt and math.sqrt((targetAt.x - playerAt.x)^2 + (targetAt.y - playerAt.y)^2 + (targetAt.z - playerAt.z)^2) or math.huge
        if gap > settings.maxOfferDistance then return {available = false, reason = 'Target too far away'} end
        local kinds = {'fight'}
        local combat = get(native.playerInCombat, player) or get(native.inCombat, target) or get(native.inCombat, actor.npc)
        local voice = converses(target)
        if voice and not combat then
            kinds[#kinds + 1] = 'distract-return'; kinds[#kinds + 1] = 'distract-fight'; kinds[#kinds + 1] = 'distract-rejoin'
        end
        local name = info.name or get(native.name, target) or 'NPC'
        if #name > 120 then name = name:sub(1, 120) end
        offers[entity] = {entity = entity, serial = actor.serial, targetId = info.id, target = target,
            planSpot = get(native.position, actor.npc), voice = voice, name = name, at = clock}
        return {available = true, actor = {serial = actor.serial, id = entity, key = actor.profileKey},
            target = {id = info.id, name = name, hostile = get(native.hostileToPlayer, target, player) == true,
                distance = math.floor(gap + 0.5)}, kinds = kinds}
    end

    local function offered(offer, kind)
        for _, value in ipairs(offer.kinds or {}) do if value == kind then return true end end
        return false
    end

    -- Called once per accepted Convai action, with the exact captured offer.
    function T.start(kind, offer, entity)
        if not KINDS[kind] or type(offer) ~= 'table' or type(offer.actor) ~= 'table' or type(offer.target) ~= 'table'
            or offer.actor.id ~= entity or not offered(offer, kind) then
            return false, 'That action is not available.'
        end
        local captured = offers[entity]
        if not captured or captured.targetId ~= offer.target.id or captured.serial ~= offer.actor.serial
            or clock - captured.at > settings.offerTtl then
            return false, 'The target changed. Ask again.'
        end
        local actor = actorFor(entity)
        if not actor or actor.serial ~= offer.actor.serial then return false, 'That companion is no longer ready.' end
        if not get(native.alive, captured.target) or get(native.key, captured.target) ~= captured.targetId then
            return false, 'The target is gone.'
        end
        local player = get(env.player)
        if not player or get(native.playerMounted, player) then return false, 'Step out of the vehicle first.' end
        local distract = kind ~= 'fight'
        if distract and (not captured.voice or get(native.playerInCombat, player) or get(native.inCombat, captured.target)) then
            return false, 'A distraction is not possible right now.'
        end
        if active then finish('replaced') end
        offers[entity] = nil
        sequence = sequence + 1
        active = {id = sequence, kind = distract and 'distract' or 'fight',
            ending = distract and kind:sub(10) or nil, serial = actor.serial, entity = entity,
            companion = actor.npc, companionKey = actor.profileKey, companionName = actor.name or offer.actor.key,
            companionBody = get(native.bodyType, actor.npc) or '',
            target = captured.target, targetId = captured.targetId, targetName = captured.name,
            voice = captured.voice, planSpot = captured.planSpot, startedAt = clock, since = clock,
            tickets = 0, trace = {}}
        if distract then
            enter('approach', 'distraction accepted')
            perception.begin(captured.target, player, actor.npc)
            active.convo = {turn = 0, lines = {}, retries = 0}
        else
            active.fightReceipt = select(2, pcall(native.startFight, actor.npc, captured.target))
            if type(active.fightReceipt) ~= 'table' then
                active.fightReceipt = nil; finish('fight-unavailable'); return false, 'Your companion could not engage that target.'
            end
            enter('fight-approach', 'fight accepted')
        end
        return true, (actor.name or 'Your companion') .. (distract and ' is going to distract ' or ' is going after ') .. captured.name .. '.'
    end

    function T.owns(serial) return active ~= nil and active.serial == serial end
    -- Only the approach and the conversation itself hold off automatic reactions
    -- and V's gaze focus; walking back or waiting does not.
    local talking = {approach = true, face = true, talk = true}
    function T.busy() return active ~= nil and active.kind == 'distract' and talking[active.phase] == true end

    -- Movement decision for the owned copy, in the companion behavior schema.
    function T.decide(serial, context, _)
        local a = active
        if not a or a.serial ~= serial then return nil end
        local operation
        if a.phase == 'approach' then
            local goal = context.targetPosition or get(native.position, a.target)
            if not goal then return nil end
            local spot = toward(context.position or goal, goal, settings.talkDistance)
            operation = op('move', spot, ground(context.position, goal) > 25 and 'Run' or 'Walk', true, false)
        elseif a.phase == 'face' then
            local goal = get(native.position, a.target)
            operation = op('turn', goal or context.position, nil, nil, nil)
        elseif a.phase == 'talk' or a.phase == 'waiting' then
            operation = op('hold')
        elseif a.phase == 'fight-approach' then
            if context.combat then operation = op('release')
            else
                local goal = get(native.position, a.target)
                if not goal then return nil end
                operation = op('move', toward(context.position or goal, goal, settings.fightApproach), 'Run', true, false)
            end
        elseif a.phase == 'fighting' then
            operation = op('release')
        elseif a.phase == 'returning' then
            operation = op('move', a.planSpot, ground(context.position, a.planSpot) > 25 and 'Run' or 'Walk', true, false)
        else
            return nil
        end
        a.lastMotion = context.motion
        a.lastPosition = context.position and copy(context.position) or a.lastPosition
        return {phase = 'tactic-' .. a.phase, reason = a.kind, operation = operation, look = 'none'}
    end

    local function speaker(a, turn)
        if turn % 2 == 1 then
            return {npc = a.companion, entity = a.entity, profileKey = a.companionKey, name = a.companionName,
                bodyType = a.companionBody, role = 'companion', partner = a.targetName}
        end
        return {npc = a.target, entity = a.targetId, profileKey = a.voice.profileKey, name = a.targetName,
            bodyType = a.voice.bodyType or get(native.bodyType, a.target) or '', role = 'target', partner = a.companionName}
    end

    local function sendTurn(a)
        local convo = a.convo
        local number = convo.turn + 1
        local who = speaker(a, number)
        local generation = get(env.nextGeneration)
        if type(generation) ~= 'number' then return false end
        local context = {generation = generation, entity = who.entity, name = who.name, bodyType = who.bodyType,
            profileKey = who.profileKey, text = 'Distraction line ' .. number, sentAt = os.time(),
            requestId = tostring(os.time()) .. '-' .. tostring(generation) .. '-' .. who.entity,
            reaction = {kind = 'distraction', scene = 'distract-' .. tostring(a.id), turn = number, role = who.role,
                ending = a.ending, partner = who.partner, lines = copy(convo.lines), expiresAt = now() + 60000}}
        -- The bridge admits an automatic turn only under a current lease.
        lease(context.requestId, true)
        if not get(env.send, context, who.npc) then lease(context.requestId, false); return false end
        convo.current = {requestId = context.requestId, generation = generation, entity = who.entity, role = who.role,
            number = number, sentAt = clock, leaseAt = clock, state = 'sent'}
        log('turn ' .. number .. ' sent (' .. who.role .. ')')
        return true
    end

    local function completeTalk(a, reason)
        endConversationTurn(a)
        releaseDistraction(a)
        log('conversation ended after ' .. #a.convo.lines .. ' lines (' .. reason .. ')')
        if a.ending == 'rejoin' then finish('completed'); return end
        if a.ending == 'return' then enter('returning', reason); return end
        local receipt = select(2, pcall(native.startFight, a.companion, a.target))
        if type(receipt) ~= 'table' then finish('fight-unavailable', 'Your companion could not engage that target.'); return end
        a.fightReceipt = receipt
        enter('fight-approach', 'distraction over')
    end

    local function turnFailed(a, why)
        local convo = a.convo
        local number = convo.current and convo.current.number or (convo.turn + 1)
        endConversationTurn(a)
        log('turn ' .. number .. ' failed: ' .. why)
        if convo.retries < settings.turnRetries then convo.retries = convo.retries + 1; return end
        completeTalk(a, 'turn ' .. number .. ' unavailable')
    end

    local function updateConversation(a)
        local convo = a.convo
        local turn = convo.current
        if not turn then
            if convo.turn >= TURNS then completeTalk(a, 'five lines'); return end
            if get(env.idle) then sendTurn(a) end
            return
        end
        if clock - turn.leaseAt >= settings.leaseEvery then
            turn.leaseAt = clock
            lease(turn.requestId, true, turn.playbackAt)
        end
        if clock - turn.sentAt > settings.turnTimeout then turnFailed(a, 'timeout'); return end
        if turn.state == 'sent' then
            if turn.received then
                turn.state, turn.playbackAt = 'playing', now()
                lease(turn.requestId, true, turn.playbackAt)
            elseif get(env.pendingId) ~= turn.requestId then
                turnFailed(a, 'request retired without a reply')
            end
            return
        end
        local transcript = get(env.transcript, turn.requestId, turn.generation, turn.entity)
        if type(transcript) == 'table' and type(transcript.text) == 'string' and transcript.text:find('%S') then
            turn.text = transcript.text
        end
        if get(env.speaking, turn.requestId) then return end
        local text = clipLine(turn.text)
        if not text then turnFailed(a, 'empty line'); return end
        convo.lines[#convo.lines + 1] = {role = turn.role, text = text}
        convo.turn, convo.retries = turn.number, 0
        lease(turn.requestId, false)
        convo.current = nil
        if convo.turn >= TURNS then completeTalk(a, 'five lines') end
    end

    function T.canDeliver(context)
        local turn = active and active.convo and active.convo.current
        return turn ~= nil and context.requestId == turn.requestId and get(native.alive, active.target) == true
            and get(native.alive, active.companion) == true
    end

    function T.received(requestId, reply)
        local turn = active and active.convo and active.convo.current
        if not turn or turn.requestId ~= requestId or turn.state ~= 'sent' then return false end
        if type(reply) ~= 'table' or reply.error or type(reply.text) ~= 'string' then turnFailed(active, 'reply error'); return true end
        turn.received, turn.text = true, reply.text
        return true
    end

    -- V started a new manual conversation: a distraction yields immediately.
    function T.interrupt(reason)
        if active and active.kind == 'distract' and active.fightReceipt == nil then
            finish(reason or 'interrupted', (active.companionName or 'Your companion') .. ' called off the distraction.')
        end
    end

    function T.update(player, dt, worldReady)
        -- Menus and loading freeze every tactic clock; nothing times out there.
        if not worldReady or not player then return end
        local step = tonumber(dt) or 0
        clock = clock + step
        for entity, captured in pairs(offers) do
            if clock - captured.at > settings.offerTtl then offers[entity] = nil end
        end
        local a = active
        if not a then return end
        perception.update(step)
        local actor = actorFor(a.entity)
        if not actor or actor.serial ~= a.serial or actor.npc ~= a.companion and get(native.key, actor.npc) ~= a.entity then
            finish('companion-unavailable'); return
        end
        if get(native.playerMounted, player) then finish('vehicle'); return end
        local targetAlive = get(native.alive, a.target) == true
        local companionAt, targetAt = get(native.position, a.companion), targetAlive and get(native.position, a.target) or nil
        local elapsed = clock - a.since
        if a.kind == 'distract' and a.fightReceipt == nil then
            if not targetAlive then finish('target-lost', 'The distraction target is gone.'); return end
            if get(native.playerInCombat, player) or get(native.inCombat, a.companion) or get(native.inCombat, a.target) then
                finish('combat', 'The distraction fell apart: combat started.'); return
            end
        end
        if a.phase == 'approach' then
            if ground(companionAt, targetAt) <= settings.arriveWithin then enter('face', 'arrived')
            elseif elapsed > settings.approachTimeout then
                finish('unreachable', (a.companionName or 'Your companion') .. ' could not reach the target.')
            end
        elseif a.phase == 'face' then
            local motion = a.lastMotion
            local turned = motion and a.operation and motion.ticket == a.operation.ticket and (motion.complete or motion.failed)
            if turned or elapsed > settings.faceTimeout then
                enter('talk', 'facing the target')
                a.engaged = select(2, pcall(native.engage, a.target, a.companion))
                if type(a.engaged) ~= 'table' then a.engaged = nil end
            end
        elseif a.phase == 'talk' then
            updateConversation(a)
        elseif a.phase == 'fight-approach' or a.phase == 'fighting' then
            if not targetAlive then finish('target-down'); return end
            local fighting = get(native.inCombat, a.companion)
            if a.phase == 'fight-approach' then
                if fighting then enter('fighting', 'native combat engaged')
                elseif elapsed > settings.fightStartTimeout then finish('no-combat', (a.companionName or 'Your companion') .. ' could not engage the target.'); return end
            end
            if clock - a.startedAt > settings.fightTimeout + (a.kind == 'distract' and 240 or 0) then finish('fight-timeout') end
        elseif a.phase == 'returning' then
            if ground(companionAt, a.planSpot) <= settings.returnArrive then enter('waiting', 'back at the planning spot')
            elseif elapsed > settings.returnTimeout then finish('return-timeout') end
        elseif a.phase == 'waiting' then
            local playerAt = get(native.position, player)
            if ground(companionAt, playerAt) <= settings.waitForV then finish('completed')
            elseif elapsed > settings.waitTimeout then finish('wait-timeout') end
        end
    end

    function T.snapshot()
        local a = active
        local value = {active = a ~= nil, last = last and copy(last) or nil, perception = perception.snapshot()}
        if a then
            value.kind, value.ending, value.phase, value.serial, value.target = a.kind, a.ending, a.phase, a.serial, a.targetId
            value.turn = a.convo and a.convo.turn or nil
            value.lines = a.convo and #a.convo.lines or nil
            value.fighting = a.fightReceipt ~= nil
        end
        return value
    end
    return T
end

return M
