-- Decide who owns locomotion and attention before issuing any engine command.
-- Inputs are measurements, not camera heading. Each copy keeps its own state.
local M = {}

local limits = {
    catchUpEnter = 4.2, catchUpLeave = 3.3,
    attentionDistance = 3.0, attentionSpeed = 0.12,
    settleSeconds = 0.65, glanceAngle = 110.0,
}

function M.new()
    return {phase = 'settling', stillFor = 0, reason = 'Joining the group'}
end

function M.decide(state, c, delta)
    local previous = state.phase
    local function choose(phase, movement, look, reason, running)
        state.phase, state.reason = phase, reason
        return {phase = phase, movement = movement, look = look,
            reason = reason, running = running == true, changed = previous ~= phase}
    end
    local function glance()
        if c.playerGap <= 4.5 and c.facingError <= limits.glanceAngle then return 'side' end
        return 'none'
    end

    if c.combat then
        state.stillFor = 0
        return choose('combat', 'release', 'none', 'Native combat owns movement')
    end

    -- A look from V is a social request, not permission to stop a running actor.
    -- Recovery also keeps navigation in charge and has a bounded caller timer.
    if c.blocked then
        state.stillFor = 0
        return choose('recover', 'follow', 'none', 'Let native navigation find a route', c.playerRunning or c.playerGap > limits.catchUpEnter)
    end
    local catching = c.playerRunning or c.playerGap > limits.catchUpEnter or c.seatGap > 5.0
    if previous == 'catch_up' and c.playerMoving and c.playerGap > limits.catchUpLeave then catching = true end
    if catching then
        state.stillFor = 0
        return choose('catch_up', 'follow', 'none', 'Catch up before seeking a side position', true)
    end

    if c.playerMoving then
        state.stillFor = 0
        local running = c.seatGap > 1.5 and c.playerSpeed > 1.0
        return choose('alongside', 'side', running and 'none' or glance(), 'Walk with the group; path controls body direction', running)
    end

    -- Once a focused companion has made the small turn step, keep that position
    -- for this stop. The step itself must not make the actor "unsettled" again.
    if previous == 'attend' and c.focusRequested and c.playerGap <= limits.attentionDistance
        and not c.playerShifted then
        return choose('attend', 'attention', 'full', 'Continue the settled conversation')
    end

    if not c.arrived then
        state.stillFor = 0
        return choose('rejoin', 'side', 'none', 'Reach a comfortable spot before turning to V')
    end
    if c.npcSpeed <= limits.attentionSpeed then state.stillFor = state.stillFor + delta
    else state.stillFor = 0 end
    if state.stillFor < limits.settleSeconds then
        return choose('settling', 'hold', 'none', 'Let the arrival animation finish')
    end
    if c.focusRequested and c.playerGap <= limits.attentionDistance then
        return choose('attend', 'attention', 'full', 'A settled companion returns direct eye contact')
    end
    return choose('idle', 'hold', glance(), 'Stay in the accepted spot with a gentle side glance')
end

return M
