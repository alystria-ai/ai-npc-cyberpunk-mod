-- A person's locomotion and social attention are one explicit state machine.
-- Inputs are measured world state and native operation feedback, never camera yaw.
local space=dofile('companion-space.lua')
local M={}
local social={attend_step=true,attend_settle=true,attend_turn=true,attend=true}
-- A refused move while V stands still: accept a stance already this close to
-- V after `accept` seconds; otherwise retry through native navigation (a new
-- side point after it) every `retry` seconds at most, then wait in place.
local refused={accept=2,near=2.5,retry=3}
local arrivals={approach=true,braking=true}
-- Height between her feet and V's beyond which a lane beside V is the wrong
-- plan: stairs or a ramp lie between them, so she follows by the navmesh
-- (live 2026-10-13: a lane move was refused at 1.2-1.4 m of rise and the
-- stalled alongside walk only became a follow after the gap grew past that).
local climb=1.0
-- A stop that leaves her this far ahead of V (along V's travel direction) is
-- corrected once by a short step to her place. The lane target leads V while
-- V moves and her stop animation carries her on, so the first stop after a
-- departure usually ends ahead of V (live 2026-10-13, 0.6 m ahead and 1.5 m aside).
local aheadLimit=.5

function M.new(id)
    return {id=id or 0,phase='joining',clock=0,since=0,sequence=0,stillFor=0,
        focusFor=0,lostFor=0,blockedFor=0,failures=0,trace={}}
end
local function enter(s,phase,reason)
    if s.phase~=phase then
        s.phase,s.since=phase,s.clock
        if #s.trace>=24 then table.remove(s.trace,1) end
        s.trace[#s.trace+1]={at=s.clock,phase=phase,reason=reason}
    end
    s.reason=reason
end
local function operation(s,kind,goal,gait,finish,face,new)
    local old=s.operation
    if new or not old or old.kind~=kind or old.finish~=finish or old.face~=face then
        s.sequence=s.sequence+1
        old={ticket=tostring(s.id)..':'..tostring(s.sequence),kind=kind}
        s.operation=old
    end
    old.goal=goal and space.copy(goal) or nil
    old.gait,old.finish,old.face=gait,finish,face
    return old
end
local function emit(s,look)
    return {phase=s.phase,reason=s.reason,operation=s.operation,look=look or 'none'}
end
local function glance(c)
    return c.playerGap<4.5 and c.facingError<110 and 'side' or 'none'
end
local function pace(c,catching)
    local speed=math.max(c.frame.speed,c.frame.rawSpeed or 0)
    -- Development only (mod/face-test.lua `lead`): walking ahead of V needs one gait more than V's.
    if convaiCompanions and convaiCompanions.devLead and speed>0.5 then return speed>3.2 and 'Sprint' or 'Run' end
    if speed>3.2 or (catching and c.playerGap>5.0) then return 'Sprint' end
    if speed>1.45 or catching then return 'Run' end
    return 'Walk'
end
local function aheadOfV(c)
    local direction=c.frame and c.frame.direction
    if not direction or not c.frame.position then return false end
    local along=(c.position.x-c.frame.position.x)*direction.x+(c.position.y-c.frame.position.y)*direction.y
    return along>aheadLimit
end
local function accept(s,c)
    s.aheadCheck=nil
    s.parked=space.copy(c.position)
    s.arrivalGoal=nil
    s.focusFor=0
    enter(s,'settled','Accept the actual stopped stance')
    operation(s,'hold')
    return emit(s,glance(c))
end
local function approach(s,c,reason)
    s.aheadCheck=nil
    s.arrivalGoal=space.copy(c.restTarget)
    s.arrivalStop=c.frame.stop
    enter(s,'approach',reason)
    operation(s,'move',s.arrivalGoal,'Walk',true,false,true)
    s.stillFor=0
    return emit(s)
end
local function recover(s,c,reason)
    s.failures=s.failures+1
    s.retryAt=s.clock+math.min(6,2+s.failures)
    s.parked=nil
    enter(s,'recover',reason)
    operation(s,'follow',nil,pace(c,true),false,false,true)
    return emit(s)
end

function M.decide(s,c,dt)
    s.clock=s.clock+dt
    local motion=c.motion or {}
    local ours=s.operation and motion.ticket==s.operation.ticket
    local done=ours and motion.complete
    local failed=ours and (motion.failed or motion.stalled)
    if c.speed<0.18 then s.stillFor=s.stillFor+dt else s.stillFor=0 end
    if c.selected then s.lostFor=0 else s.lostFor=s.lostFor+dt end
    if c.yieldTarget then s.blockedFor=s.blockedFor+dt else s.blockedFor=0 end

    if c.combat then
        enter(s,'combat','Native combat owns locomotion')
        operation(s,'release')
        s.focusFor,s.parked,s.attentionAnchor=0,nil,nil
        return emit(s)
    end
    if s.epoch~=c.frame.epoch then
        s.epoch=c.frame.epoch
        s.parked,s.attentionAnchor=nil,nil
        s.focusFor,s.failures=0,0
    end

    local obstructed=ours and (motion.blocked or motion.route and motion.route.kind=='waypoints'
        and (motion.failed or motion.stalled))
    local retaining=s.phase=='obstructed' and ours and (motion.waiting
        or motion.route and motion.route.kind=='waypoints' and not done)
    if obstructed and s.phase=='attend_step' then
        -- The attention footstep is cosmetic. A rejected route is simply
        -- skipped: hold the settled stance, never wait for or plan a detour.
        enter(s,'attend_settle','Skip the rejected attention step and stay settled')
        operation(s,'hold')
        s.stillFor=0
        return emit(s,'full')
    end
    if (obstructed or retaining) and not s.operation.face then
        -- A lane goal beyond V is obsolete once we are already safely nearby.
        -- Do not preserve that rejected crossing ahead of the ordinary stop
        -- decision forever. Holding retires movement; it grants no new route.
        if not c.frame.moving and c.nearGroup and s.stillFor>=0.65
            and motion.rejection and motion.rejection.stage=='player' then
            s.obstructedPhase=nil
            return accept(s,c)
        end
        if c.frame.moving then
            local chasing=c.playerGap>5.0 or c.targetGap>6.0
                or math.abs(c.position.z-c.frame.position.z)>climb
            -- Preserve an ongoing search only while its intended operation is
            -- still current. An arrival cannot retain finish/Walk as V departs,
            -- and a distant walking copy must be allowed to become a follower.
            if s.operation.kind=='move' and (s.operation.finish or chasing or c.frame.justDeparted) then
                s.obstructedPhase,s.arrivalGoal,s.parked=nil,nil,nil
                enter(s,chasing and 'catch_up' or 'alongside','Update the obstructed operation for actual departure')
                operation(s,chasing and 'follow' or 'move',not chasing and c.travelTarget or nil,
                    pace(c,chasing),false,false,true)
                return emit(s)
            end
            s.operation.gait=pace(c,s.operation.kind=='follow')
        end
    end
    if obstructed then
        if s.phase~='obstructed' then s.obstructedPhase=s.phase end
        enter(s,'obstructed',motion.waiting and 'Check a safe detour while holding the current stance'
            or 'Wait for the rejected geometry or destination to change')
        -- A rejected route is still owned by the actuator. A new recovery
        -- ticket would erase its search and retry the same navmesh every six
        -- seconds. Real departure may move the goal; camera turns may not.
        if s.operation.kind=='move' and not s.operation.face and c.frame.moving
            and space.ground(s.operation.goal,c.travelTarget)>2 then
            s.operation.goal=space.copy(c.travelTarget)
            s.arrivalGoal=space.copy(c.travelTarget)
        end
        if s.operation.kind=='follow' then s.operation.gait=pace(c,true) end
        -- Never wait forever for geometry that will not change. Live trace
        -- 2026-10-08: Judy stood refused 0.6 m from a still V in V's
        -- apartment for 8 minutes, and 2.8 m outside V's lift car for 65 s.
        if not c.frame.moving and not motion.waiting and s.phase=='obstructed' then
            local waited=s.clock-s.since
            if waited>=refused.accept and c.playerGap<=refused.near then
                s.obstructedPhase=nil
                return accept(s,c)
            end
            if waited>=refused.retry and s.clock>=(s.retryAt or 0) then
                s.obstructedPhase=nil
                if s.failures>=3 and c.playerGap<5.5 then
                    enter(s,'waiting','Wait in available space after refused routes')
                    operation(s,'hold')
                    return emit(s,glance(c))
                end
                return recover(s,c,'A refused move: retry through native navigation')
            end
        end
        return emit(s,glance(c))
    end
    if s.phase=='obstructed' then
        if ours and (motion.waiting or motion.route and motion.route.kind=='waypoints' and not done) then
            if s.operation.kind=='follow' then s.operation.gait=pace(c,true) end
            return emit(s,glance(c))
        end
        local phase=s.obstructedPhase or 'joining'
        s.obstructedPhase=nil
        enter(s,phase,'Resume the original operation after obstruction clearance')
    end

    -- A look behind at a follower cannot create a body-turn operation.
    if c.frame.moving then
        s.focusFor,s.parked=0,nil
        if s.phase=='recover' and s.clock<(s.retryAt or 0) then return emit(s) end
        if failed then return recover(s,c,'A walking route is blocked; yield to native navigation') end
        -- Keep the existing forward target through the short stop debounce.
        -- Recomputing its speed lead while V decelerates pulls it backwards.
        if c.frame.rawSpeed<0.28 and (s.phase=='alongside' or s.phase=='catch_up') then
            return emit(s)
        end
        local chasing=c.playerGap>5.0 or c.targetGap>6.0 or math.abs(c.position.z-c.frame.position.z)>climb
        if s.phase=='catch_up' and c.playerGap>3.2 then chasing=true end
        if chasing then
            enter(s,'catch_up','Catch up along the path before finding side space')
            operation(s,'follow',nil,pace(c,true),false,false)
            return emit(s)
        end
        enter(s,'alongside','Travel in a stable lane using actual world displacement')
        operation(s,'move',c.travelTarget,pace(c,false),false,false)
        return emit(s,c.speed<2.0 and glance(c) or 'none')
    end

    if s.phase=='combat' then
        s.stillFor=0
        enter(s,'joining','Reassess the group after combat')
        s.operation=nil
    end
    if s.phase=='recover' then
        if c.comfortable and s.stillFor>=0.65 then return accept(s,c) end
        if s.clock<(s.retryAt or 0) then return emit(s) end
        if s.failures>=3 and c.playerGap<5.5 then
            enter(s,'waiting','Wait in available space instead of retrying a blocked seat')
            operation(s,'hold')
            return emit(s,glance(c))
        end
        return approach(s,c,'Try a new side approach after navigation recovery')
    end
    if s.phase=='waiting' then
        if c.playerGap>5.5 then return recover(s,c,'The group has moved away') end
        return emit(s,glance(c))
    end
    -- Only members actually standing with the gathering wait with it. A copy
    -- left far behind (another companion keeps V's gathering alive) catches up.
    local waitingWithGroup=c.frame.localInteraction and (s.phase=='settled' or social[s.phase])
        and c.playerGap<=10.0
    if c.playerGap>5.0 and not arrivals[s.phase] and not waitingWithGroup then
        enter(s,'catch_up','Reach the stopped group before choosing a stance')
        operation(s,'follow',nil,pace(c,true),false,false)
        return emit(s)
    end
    if s.phase=='joining' then
        if c.comfortable then
            operation(s,'hold')
            if s.stillFor>=0.65 then return accept(s,c) end
            return emit(s)
        end
        return approach(s,c,'Join a free place beside the group')
    end

    if s.phase=='alongside' or s.phase=='catch_up' then
        -- Stop once already beside V. Hold initiates braking; it does not
        -- declare a parked pose. Accept the eventual measured resting place.
        if c.comfortable or s.phase=='catch_up' and ours and motion.afterEscape and c.nearGroup then
            s.arrivalGoal=nil
            s.arrivalStop=c.frame.stop
            s.aheadCheck=true
            enter(s,'braking','Finish the current forward movement and stop naturally')
            operation(s,'hold')
            s.stillFor=0
            return emit(s)
        end
        return approach(s,c,'Approach free side space after catch-up')
    end
    if arrivals[s.phase] then
        local goal=ours and motion.target or s.arrivalGoal
        local gap=goal and space.ground(c.position,goal) or 0
        if s.phase=='approach' and (gap<math.max(0.7,c.speed*0.7) or done) then
            -- Same operation throughout braking, including native Success
            -- followed by residual stop-animation root motion.
            enter(s,'braking','Let the native stop finish before accepting a position')
            s.stillFor=0
        end
        if s.phase=='braking' then
            if s.stillFor>=0.65 and s.clock-s.since>=0.8 then
                if c.nearGroup then
                    if s.aheadCheck and aheadOfV(c) and s.failures<2 then
                        s.aheadCheck=nil
                        return approach(s,c,'Stopped ahead of V: step back to the place beside V')
                    end
                    s.aheadCheck=nil
                    return accept(s,c)
                end
                if s.failures<2 then return recover(s,c,'The final stance is outside the group') end
            end
            if failed and not c.nearGroup then return recover(s,c,'The approach could not complete') end
            if s.clock-s.since>7 and not c.nearGroup then return recover(s,c,'Arrival has not reached usable space') end
            return emit(s,c.speed<0.6 and glance(c) or 'none')
        end
        if failed then return recover(s,c,'The side approach is obstructed') end
        return emit(s,c.speed<0.6 and glance(c) or 'none')
    end
    if s.phase=='yield' then
        if done or failed or s.clock-s.since>2.5 then
            enter(s,'braking','Settle after making room for another companion')
            s.arrivalGoal=space.copy(c.position)
            s.stillFor=0
        end
        return emit(s)
    end

    -- Peer overlap may need a step. V intentionally standing close does not.
    if s.blockedFor>0.6 and (not social[s.phase] or s.phase=='attend') then
        enter(s,'yield','Give an overlapping companion room')
        operation(s,'move',c.yieldTarget,'Walk',true,false,true)
        s.stillFor=0
        return emit(s)
    end
    if social[s.phase] and (s.lostFor>0.75 or c.playerGap>3.6) then
        if c.speed>0.18 then
            enter(s,'braking','Finish the social step without reversing it')
            s.arrivalGoal=space.copy(c.position)
            return emit(s)
        end
        return accept(s,c)
    end
    if s.phase=='attend_step' then
        if done or failed or s.clock-s.since>2.5 then
            enter(s,'attend_settle','Let the social step finish moving the feet')
            s.stillFor=0
        end
        return emit(s,'full')
    end
    if s.phase=='attend_settle' then
        if s.stillFor>=0.35 then
            s.parked=space.copy(c.position)
            if c.facingError>14 then
                enter(s,'attend_turn','Turn toward the person being addressed')
                operation(s,'turn',c.frame.position,nil,true,true,true)
            else
                enter(s,'attend','Maintain comfortable eye contact')
                operation(s,'hold')
            end
        end
        return emit(s,'full')
    end
    if s.phase=='attend_turn' then
        if c.facingError<12 or done or failed or s.clock-s.since>3 then
            enter(s,'attend','Finish the single social turn without looping')
            operation(s,'hold')
        end
        return emit(s,'full')
    end
    if s.phase=='attend' then
        if c.selected and c.frame.stillFor>=0.65 and s.stillFor>=0.65
            and c.facingError>35 and s.attentionAnchor
            and space.ground(s.attentionAnchor,c.frame.position)>0.8 then
            -- V has finished moving around this person. Only this person may
            -- make a fresh social adjustment; the group's lanes remain still.
            return accept(s,c)
        end
        return emit(s,'full')
    end

    -- Arrival glances are not banked as requests to rotate after stopping.
    if s.phase=='settled' and c.selected and c.frame.stillFor>=0.65 and s.stillFor>=0.65
        and c.playerGap<=3.0 then s.focusFor=s.focusFor+dt else s.focusFor=0 end
    if s.focusFor>=0.5 then
        s.focusFor=0
        local stepAllowed=not s.attentionAnchor or space.ground(s.attentionAnchor,c.frame.position)>0.8
        s.attentionAnchor=space.copy(c.frame.position)
        if stepAllowed and c.playerGap>1.2 and c.facingError>15 then
            local size=math.min(0.16,c.playerGap-1.2)
            local goal=space.offset(c.position,space.bearing(c.position,c.frame.position),0,size)
            enter(s,'attend_step','One small natural footstep for direct attention')
            operation(s,'move',goal,'Walk',true,true,true)
        else
            enter(s,'attend_settle','Use the existing comfortable stance for attention')
            operation(s,'hold')
        end
        return emit(s,'full')
    end
    operation(s,'hold')
    return emit(s,glance(c))
end
return M
