-- Equipment belongs to each managed copy, independently of its locomotion ticket.
-- Native contracts: core/ai/aiCommand.script:384 (AIUnequipCommand),
-- cyberpunk/ai/commands/aiEquipItemCommand.script:30 (slotId), and
-- cyberpunk/puppet/scriptedPuppet.script:2284 (typed hand-weapon reads).
local M = {}
local slots = {'AttachmentSlots.WeaponRight', 'AttachmentSlots.WeaponLeft'}
local quietSeconds, commandSeconds, maxAttempts = 2.5, 6, 2
-- After combat the holster must not wait for V to stand still. Once calm has
-- lasted holsterDelay with a weapon still drawn, the movement owner is asked
-- (M.wantsStop) to hold the companion in place; the holster then needs the feet
-- stopped for settleSeconds. A stop that does not reach the holster inside
-- stopLimit is abandoned and not asked again for stopCooldown. A companion the
-- engine still calls Alerted is treated as relaxed after alertedCalm of calm.
local holsterDelay, settleSeconds, stopLimit, stopCooldown, alertedCalm = 3, 1, 8, 20, 6

local function copy(value)
    if type(value) ~= 'table' then return value end
    local result = {}; for key, item in pairs(value) do result[key] = copy(item) end
    return result
end
local function flag(value, name)
    if type(value) ~= 'boolean' then error(name .. ' unavailable') end
    return value
end
local function commandState(ai, command)
    local value = ai:GetCommandState(command)
    if value == nil then error('Equipment command state unavailable') end
    return tostring(value)
end
-- Game Reflection AI::CommandState; NotExecuting is still owned/active in
-- AIComponent.OnCommandStateChanged, not an acknowledged terminal state.
local function stateName(state)
    return state:match('^AICommandState%s*:%s*(%w+)%s*%(%d+%)$') or state
end
local function active(state)
    local name=stateName(state)
    return name=='Executing' or name=='Enqueued' or name=='NotExecuting'
end
local function terminal(state)
    local name=stateName(state)
    return name=='Success' or name=='Failure' or name=='Cancelled' or name=='Interrupted'
end

function M.new(npc)
    return {npc = npc, clock = 0, poll = 0, armed = true, phase = 'waiting',
        reason = 'spawn', attempts = {}, commands = 0, episode = 1}
end

-- Cancel only our equipment command. Never clear a role, all commands, hand
-- attachments, inventory, or the movement actuator's command reference.
local function cancel(s)
    s.handoff,s.handoffAt,s.handoffReady=false,nil,nil
    if not s.command then s.cancellation=nil; return true end
    local pending=s.cancellation
    if not pending or pending.command~=s.command then
        pending={command=s.command,requested=false}; s.cancellation=pending
    end
    local ok, ended = pcall(function()
        if not s.npc or not s.npc:IsAttached() then return true end
        local ai = s.npc:GetAIControllerComponent()
        local state = commandState(ai, pending.command)
        s.commandState = state
        if terminal(state) then return true end
        if not active(state) then error('Equipment command state unknown') end
        if pending.requested or s.cancelFailed then return false end
        pending.requested=true
        local result
        if stateName(state)=='Executing' then result=ai:StopExecutingCommand(pending.command,true)
        else result=ai:CancelCommand(pending.command) end
        if result == false then error('Native equipment cancellation refused') end
        s.commandState=commandState(ai,pending.command)
        return terminal(s.commandState)
    end)
    if not ok then
        s.cancelFailed, s.armed, s.phase = true, false, 'failed'
        s.reason, s.error = 'Equipment cancellation unavailable', tostring(ended)
        return false
    end
    if not ended then
        if not s.cancelFailed then s.phase,s.reason='cancelling','Waiting for native holster cancellation' end
        return false
    end
    s.command, s.finishedAt, s.cancellation = nil, nil, nil
    return true
end

function M.release(s)
    if not s then return end
    s.releaseRequested=true
    local released=cancel(s)
    s.armed, s.readySince = false, nil
    if released then s.phase, s.reason = 'released', 'Managed copy dismissed' end
end

function M.abandon(s)
    if not s then return end
    -- Called after detach/death/world teardown. No native reads or cancellation.
    s.npc, s.command, s.finishedAt, s.readySince = nil, nil, nil, nil
    s.handoff,s.handoffAt,s.handoffReady=false,nil,nil
    s.cancellation,s.releaseRequested=nil,nil
    s.armed, s.phase, s.reason = false, 'abandoned', 'Native lifetime ended'
end

local function hands(npc)
    local result = {}
    for index = 1, 2 do
        local getter = ScriptedPuppet.GetWeaponRight
        if index == 2 then getter = ScriptedPuppet.GetWeaponLeft end
        local item = getter(npc)
        local row = {present = item ~= nil}
        if item then
            local id = item:GetItemID()
            if not ItemID.IsValid(id) then error('Hand item identity unavailable') end
            row.fists = flag(WeaponObject.IsFists(id), 'Fist classification')
            row.item = tostring(ItemID.GetCombinedHash(id))
            row.record = tostring(ItemID.GetTDBID(id))
        end
        result[slots[index]] = row
    end
    return result
end

local function wait(s, reason)
    s.readySince = nil
    if not cancel(s) then return end
    s.phase, s.reason = s.armed and 'waiting' or 'complete', reason
end

local function failAttempt(s, reason)
    if not cancel(s) then return end
    s.reason, s.readySince, s.retryAt = reason, nil, s.clock + 1
    if (s.attempts[s.slot] or 0) >= maxAttempts then
        s.armed, s.phase = false, 'failed'
    else s.phase = 'waiting' end
end

local function tick(s, player, idle, acquireHold)
    local npc = s.npc
    if not flag(npc:IsAttached(), 'NPC attachment') or flag(npc:IsDeadNoStatPool(), 'NPC life') then
        M.abandon(s); return
    end
    if (s.cancelFailed or s.cancellation) and s.command then
        -- A failed cancellation cannot hold the walking controller hostage or
        -- erase our native command reference. Observe it until it ends; do not
        -- submit replacements or repeatedly invoke the failing cancel method.
        if not cancel(s) then return end
        if s.releaseRequested then s.phase,s.reason='released','Managed copy dismissed'; return end
        if s.cancelFailed then s.reason='Native holster ended after cancellation failed'; return end
    end
    s.stopWanted = false -- re-established below once every guard has passed
    if not player or not flag(player:IsAttached(), 'Player attachment')
        or flag(player:IsDeadNoStatPool(), 'Player life') then
        s.calmSince = nil
        wait(s, 'Player unavailable'); return
    end
    local combat = {player = flag(player:IsInCombat(), 'Player combat'),
        npc = flag(NPCPuppet.IsInCombat(npc), 'NPC combat')}
    s.guard = {playerCombat = combat.player, npcCombat = combat.npc}
    if combat.player or combat.npc then
        if not s.wasCombat then
            s.episode, s.attempts, s.armed = s.episode + 1, {}, true
            s.retryAt,s.cancelFailed = nil,nil
        end
        s.wasCombat, s.calmSince, s.stopSince = true, nil, nil
        wait(s, 'Native combat owns equipment'); return
    end
    s.wasCombat = false
    if not s.armed or s.cancelFailed then return end

    local guard = s.guard
    -- V's tracker can retain a location-only threat after a vehicle impact even
    -- when both actors are calm and no hostile entity remains. That memory must
    -- not keep a follower armed; real entity threats still defer holstering.
    guard.playerThreat = flag(TargetTrackingExtension.HasHostileThreat(player, false, true), 'Player entity threats')
    guard.npcThreat = flag(TargetTrackingExtension.HasHostileThreat(npc), 'NPC threats')
    guard.autonomous = flag(npc:IsOnAutonomousAI(), 'NPC autonomy')
    guard.relaxed = npc:GetHighLevelStateFromBlackboard() == Enum.new('gamedataNPCHighLevelState', 'Relaxed')
    if guard.playerThreat or guard.npcThreat then
        s.calmSince, s.stopSince = nil, nil
        wait(s, 'Hostile threat remains'); return
    end
    -- Calm: out of combat with no hostile entity. Time spent walking counts.
    s.calmSince = s.calmSince or s.clock
    local calm = s.clock - s.calmSince
    if not guard.relaxed and guard.autonomous and calm >= alertedCalm then
        local ok, alerted = pcall(function()
            return npc:GetHighLevelStateFromBlackboard() == Enum.new('gamedataNPCHighLevelState', 'Alerted')
        end)
        guard.relaxed = ok and alerted == true
    end
    if not guard.autonomous or not guard.relaxed then wait(s, 'NPC is not relaxed autonomous AI'); return end
    local scene = Game.GetSceneSystem():GetScriptInterface()
    guard.tier = PlayerPuppet.GetSceneTier(player)
    guard.playerDialogue = flag(scene:IsEntityInDialogue(player:GetEntityID()), 'Player dialogue')
    guard.npcScene = flag(scene:IsEntityInScene(npc:GetEntityID()), 'NPC scene')
    guard.npcDialogue = flag(scene:IsEntityInDialogue(npc:GetEntityID()), 'NPC dialogue')
    if guard.tier ~= 1 or guard.playerDialogue or guard.npcScene or guard.npcDialogue then
        wait(s, 'Native scene or dialogue owns equipment'); return
    end
    guard.idle = idle == true
    s.hands = hands(npc)
    local drawn
    for _, name in ipairs(slots) do
        if s.hands[name].present and not s.hands[name].fists then drawn = name; break end
    end
    -- A weapon is still drawn after a calm holsterDelay (or the holster is under
    -- way): ask the movement owner to hold her still, for a bounded time.
    local want = (drawn ~= nil and calm >= holsterDelay) or s.command ~= nil or s.handoff == true
    if want and s.clock < (s.stopCooldownUntil or 0) then want = false end
    if want then
        s.stopSince = s.stopSince or s.clock
        if s.command == nil and s.clock - s.stopSince > stopLimit then
            want, s.stopSince, s.stopCooldownUntil = false, nil, s.clock + stopCooldown
            wait(s, 'Holster stop limit reached'); return
        end
    else
        s.stopSince = nil
    end
    s.stopWanted = want
    if not guard.idle then wait(s, 'Wait until settled'); return end

    if s.command then
        local ai = npc:GetAIControllerComponent()
        local state = commandState(ai, s.command)
        s.commandState = state
        local hand = s.hands[s.slot]
        local occupied = hand.present and not hand.fists
        if stateName(state)=='Success' and not occupied then
            s.command, s.finishedAt, s.readySince = nil, nil, nil
            s.phase, s.reason = 'waiting', 'Hand cleared; allow the native animation to settle'
            local remaining = false
            for _, name in ipairs(slots) do
                if s.hands[name].present and not s.hands[name].fists then remaining = true end
            end
            if not remaining then
                s.armed, s.phase, s.reason = false, 'complete', 'Native holster verified'
                s.handoff,s.handoffAt,s.handoffReady=false,nil,nil
            end
            return
        end
        if s.clock - s.issuedAt >= commandSeconds then
            failAttempt(s, 'Native holster timed out'); return
        end
        if not active(state) then
            s.finishedAt = s.finishedAt or s.clock
            -- A terminal command is not proof of a cleared hand. Give queued
            -- attachment events a short grace, then retry once at most.
            if s.clock - s.finishedAt >= 0.75 then failAttempt(s, 'Holster ended without verified slot clearance') end
        end
        return
    end

    local slot
    for _, name in ipairs(slots) do
        if s.hands[name].present and not s.hands[name].fists then slot = name; break end
    end
    local upper = npc:GetPuppetStateBlackboard():GetInt(Game.GetAllBlackboardDefs().PuppetState.UpperBody)
    guard.upperNormal = Enum.new('gamedataNPCUpperBodyState', upper) == Enum.new('gamedataNPCUpperBodyState', 'Normal')
    if not guard.upperNormal then wait(s, 'Native upper body is busy'); return end
    if s.retryAt and s.clock < s.retryAt then return end
    s.readySince = s.readySince or s.clock
    s.phase, s.reason = 'waiting', 'Confirming a calm settled stance'
    if s.clock - s.calmSince < quietSeconds or s.clock - s.readySince < math.min(settleSeconds, quietSeconds) then return end
    -- Newly spawned equipment may attach after the actor. Empty hands on the
    -- first sample are not a settled baseline until this same calm interval.
    if not slot then
        s.armed, s.phase, s.reason, s.readySince = false, 'complete', 'No drawn hand weapons', nil
        return
    end
    if not s.handoffReady then
        if type(acquireHold)~='function' then
            s.phase,s.reason='waiting','An owned idle hold handoff is required';return
        end
        s.handoff,s.handoffAt=true,s.handoffAt or s.clock
        local ok,ready,reason=pcall(acquireHold)
        if not ok then
            cancel(s)
            s.armed,s.phase,s.reason,s.error=false,'failed','Owned idle hold release failed',tostring(ready)
            return
        end
        if ready~=true then
            s.phase,s.reason='handoff',reason or 'Waiting for the owned idle hold to stop'
            if s.clock-s.handoffAt>=2 then
                cancel(s)
                s.armed,s.phase,s.reason=false,'failed','Owned idle hold did not release in time'
            end
            return
        end
        s.handoffReady=true
    end
    if (s.attempts[slot] or 0) >= maxAttempts then
        s.armed, s.phase, s.reason = false, 'failed', 'Holster attempt limit reached'; return
    end
    s.slot = slot
    s.attempts[slot] = (s.attempts[slot] or 0) + 1
    local command = NewObject('AIUnequipCommand')
    command.slotId = TweakDBID.new(slot)
    -- Preserve the native duration/animation default; do not snap-remove items.
    s.command, s.issuedAt, s.finishedAt, s.commandState = command, s.clock, nil, nil
    s.stopSince = s.clock -- the stop reached its holster; the command has its own time limit
    local accepted = npc:GetAIControllerComponent():SendCommand(command)
    if accepted == false then
        s.command = nil; failAttempt(s, 'Native holster request refused'); return
    end
    s.commandID, s.commands = tonumber(command.id), s.commands + 1
    s.phase, s.reason, s.error = 'unequipping', 'Native holster requested', nil
end

function M.update(s, player, delta, idle, acquireHold)
    if not s or not s.npc or s.phase == 'released' or s.phase == 'abandoned' then return end
    local dt = tonumber(delta) or 0
    if dt ~= dt or dt < 0 then return end
    dt = math.min(dt, 1)
    s.clock, s.poll = s.clock + dt, s.poll + dt
    if s.handoff and idle~=true then wait(s,'Movement takes priority') end
    if s.poll < 0.25 then return end
    s.poll = 0
    local ok, err = pcall(tick, s, player, idle, acquireHold)
    if not ok then
        wait(s, 'Equipment observation unavailable')
        s.error = tostring(err)
    end
end

function M.holdsMovement(s)
    return s~=nil and s.handoff==true
end

-- True while the movement owner should keep this companion standing so a drawn
-- weapon can be holstered although V keeps moving (see holsterDelay).
function M.wantsStop(s)
    return s~=nil and s.stopWanted==true and s.armed==true
end

function M.snapshot(s)
    if not s then return {phase = 'uninitialized'} end
    return {phase = s.phase, reason = s.reason, error = s.error, armed = s.armed,
        episode = s.episode, attempts = copy(s.attempts), commands = s.commands,
        commandID = s.commandID, commandState = s.commandState, active = s.command ~= nil,
        movementSuspended = s.handoff == true, holdReleased = s.handoffReady == true,
        slot = s.slot, guard = copy(s.guard), hands = copy(s.hands), stopWanted = s.stopWanted == true,
        calm = s.calmSince and math.max(0, s.clock - s.calmSince) or nil,
        age = s.issuedAt and math.max(0, s.clock - s.issuedAt), cancellationFailed = s.cancelFailed == true}
end

return M
