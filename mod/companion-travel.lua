-- Purposeful group travel inferred from displacement, never view direction.
local space=dofile('companion-space.lua')
local M={}
function M.new(position,initialDirection)
    return {position=space.copy(position),previous=space.copy(position),
        stopAnchor=space.copy(position),direction=space.unit(initialDirection.x,initialDirection.y),
        moving=false,speed=0,rawSpeed=0,stillFor=10,activeFor=0,epoch=0,stop=0,reversal=0,
        clock=0,history={{position=space.copy(position),time=0}},
        path={{position=space.copy(position),direction=space.unit(initialDirection.x,initialDirection.y),distance=0}},pathDistance=0}
end

function M.update(s,position,dt)
    dt=math.max(0.001,dt)
    s.clock=s.clock+dt
    local stride=space.ground(position,s.previous)
    s.discontinuity=stride>12 or math.abs(position.z-s.previous.z)>3
    s.rawSpeed=s.discontinuity and 0 or stride/dt
    local alpha=1-math.exp(-dt/0.22)
    s.speed=s.speed+(s.rawSpeed-s.speed)*alpha
    s.position=space.copy(position)
    if s.rawSpeed<0.28 then s.stillFor=s.stillFor+dt; s.activeFor=0
    else s.stillFor=0; s.activeFor=s.activeFor+dt end
    s.justStopped,s.justDeparted=false,false
    if s.discontinuity then
        s.moving,s.speed,s.stillFor=false,0,0
        s.pendingTurn,s.activeFor=nil,0
        s.stopAnchor=space.copy(position)
        s.epoch,s.stop=s.epoch+1,s.stop+1
        s.history,s.path={},{{position=space.copy(position),distance=0}}
        s.pathDistance=0
    end
    local departure=space.ground(position,s.stopAnchor)
    if not s.moving and ((departure>1.0 and s.activeFor>=0.3) or departure>2.2) then
        s.moving,s.justDeparted=true,true
        s.epoch=s.epoch+1
    elseif s.moving and s.stillFor>=0.6 then
        s.moving,s.justStopped=false,true
        s.stopAnchor=space.copy(position)
        s.stop=s.stop+1
        s.pendingTurn=nil
    end

    s.history[#s.history+1]={position=space.copy(position),time=s.clock}
    while #s.history>2 and s.clock-s.history[1].time>0.85 do table.remove(s.history,1) end
    if s.moving and #s.history>1 then
        local base=s.history[1].position
        local net=space.ground(base,position)
        if net>0.5 then
            local candidate=space.bearing(base,position)
            local angle=space.angle(s.direction,candidate)
            if angle>110 then
                -- A brief backwards step while checking on a friend is not a
                -- group U-turn. A sustained reverse path is.
                s.pendingTurn=s.pendingTurn or {position=space.copy(position),time=s.clock}
                if space.ground(s.pendingTurn.position,position)>0.9 and s.clock-s.pendingTurn.time>0.3 then
                    s.direction=candidate; s.reversal=s.reversal+1; s.pendingTurn=nil
                end
            else
                s.pendingTurn=nil
                local blend=math.min(1,dt*3.5)
                s.direction=space.unit(s.direction.x*(1-blend)+candidate.x*blend,
                    s.direction.y*(1-blend)+candidate.y*blend)
            end
        end
    end
    local last=s.path[#s.path]
    local length=space.ground(last.position,position)
    if s.moving and length>=0.3 then
        s.pathDistance=s.pathDistance+length
        s.path[#s.path+1]={position=space.copy(position),direction=space.copy(s.direction),distance=s.pathDistance}
        while #s.path>64 do table.remove(s.path,1) end
    end
    s.previous=space.copy(position)
    s.running=s.moving and math.max(s.speed,s.rawSpeed)>2.5
    return s
end

function M.laneFrame(s,slot)
    local row=math.floor((slot-1)/2)
    local behind=row==0 and 0 or (row==1 and 0.9 or row*1.1)
    local position,direction=space.copy(s.position),s.direction
    if behind>0 then
        local remaining=behind
        for i=#s.path,2,-1 do
            local a,b=s.path[i-1].position,s.path[i].position
            local length=space.ground(a,b)
            if length>=remaining then
                local fraction=length>0 and remaining/length or 0
                position={x=b.x+(a.x-b.x)*fraction,y=b.y+(a.y-b.y)*fraction,
                    z=b.z+(a.z-b.z)*fraction,w=1}
                direction=s.path[i].direction or s.direction
                break
            end
            remaining=remaining-length
            if i==2 then position=space.offset(a,s.direction,0,-remaining) end
        end
    end
    local lead=math.min(1.25,s.speed*0.4)
    return {position=space.offset(position,direction,0,lead),direction=direction}
end
return M
