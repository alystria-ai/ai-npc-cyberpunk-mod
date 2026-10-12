-- Doors, lifts and floor changes between a companion and V.
-- Live reflection (2026-10-08, Codeware) on 2.31:
--   PlayerStateMachineDef.IsPlayerInsideElevator / IsPlayerInsideMovingElevator
--   are Bools on V's local PlayerStateMachine blackboard; inside is true only
--   in a lift car. Reading them is a blackboard lookup, no hook.
--   Door.whoOpened is V's handle after V walks through an AUTOMATIC door.
--   DoorControllerPS:ActionToggleOpen() queued through
--   PersistencySystem:QueuePSDeviceEvent opens a closed door; the door closes
--   itself again (automaticallyClosesItself). ActionDoorOpeningToken() returned
--   nil, so companions are not given opening tokens.
-- Every engine call is wrapped; an unavailable answer is never treated as
-- evidence that a door or lift is absent.
local M={}
M.policy={
    -- A door counts as "between" when it stands this close to the straight
    -- line from the companion to V.
    doorLane=4,doorRise=2.5,doorSearch=30,
    -- The same door is not reopened more often than this.
    doorReopen=6,
    -- Trail: V's recent footholds, used when no spot around V itself works
    -- (V standing in a lift car or a doorway with no navmesh underfoot).
    trailSpacing=1.5,trailLength=16,
    -- A lift car: standing spots this far from V, eight bearings per ring,
    -- at most carQueries physics queries per update; the car floor must lie
    -- within carFloor of V's feet.
    carRings={.95,1.3},carQueries=24,carFloor=.3,
    -- Boarding gait: V waits inside the car, so she hurries. Walk only for the
    -- last boardWalk metres (a straight move with no navmesh must not overshoot),
    -- jog (Run) beyond, sprint beyond boardSprint; the follow pace sprints from
    -- 5 m too (companion-behavior.lua pace).
    boardWalk=1.5,boardSprint=5,
}

-- Movement type for a walk onto a lift car floor, by metres still to go.
function M.boardGait(gap)
    local policy=M.policy
    if gap<=policy.boardWalk then return 'Walk' end
    if gap>policy.boardSprint then return 'Sprint' end
    return 'Run'
end

local function ground(a,b) return math.sqrt((a.x-b.x)^2+(a.y-b.y)^2) end
local function copy(p) return {x=p.x,y=p.y,z=p.z} end

-- Plain V lift state: {inside=bool,moving=bool}, or nil when unreadable.
function M.liftState(player)
    local ok,inside,moving=pcall(function()
        local defs=Game.GetAllBlackboardDefs().PlayerStateMachine
        local board=Game.GetBlackboardSystem():GetLocalInstanced(player:GetEntityID(),defs)
        if not board then return nil end
        return board:GetBool(defs.IsPlayerInsideElevator)==true,
            board:GetBool(defs.IsPlayerInsideMovingElevator)==true
    end)
    if not ok or inside==nil then return nil end
    return {inside=inside,moving=moving==true}
end

-- Distance from point p to segment a-b on the ground plane.
function M.laneDistance(p,a,b)
    local dx,dy=b.x-a.x,b.y-a.y
    local length=dx*dx+dy*dy
    local t=length>1e-6 and math.max(0,math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/length)) or 0
    return math.sqrt((p.x-(a.x+dx*t))^2+(p.y-(a.y+dy*t))^2)
end

local function playerHash(player)
    local ok,value=pcall(function() return tostring(player:GetEntityID().hash) end)
    return ok and value or nil
end

-- The closest closed door V itself opened, standing between the companion
-- at `from` and V at `to`. Locked, sealed and lift doors are never chosen:
-- a lift door belongs to its car and V could not open the others either.
-- Returns door,info or nil,reason.
function M.findDoor(player,from,to)
    local own=playerHash(player)
    if not own then return nil,'player-unavailable' end
    local ok,parts=pcall(function()
        local query=TargetSearchQuery.new()
        query.testedSet=TargetingSet.Complete
        query.maxDistance=math.min(M.policy.doorSearch,ground(from,to)+4)
        query.filterObjectByDistance=true
        query.ignoreInstigator=true
        local _,found=Game.GetTargetingSystem():GetTargetParts(player,query)
        return found
    end)
    if not ok then return nil,'query-unavailable' end
    local best,bestInfo,bestDistance,skipped=nil,nil,math.huge,nil
    local seen={}
    for _,part in ipairs(parts or {}) do
        local read,door,info=pcall(function()
            local entity=part:GetComponent():GetEntity()
            if not entity or not entity:IsA('Door') then return nil end
            local id=tostring(entity:GetEntityID().hash)
            if seen[id] then return nil end
            seen[id]=true
            local at=entity:GetWorldPosition()
            if M.laneDistance(at,from,to)>M.policy.doorLane or math.abs(at.z-from.z)>M.policy.doorRise then return nil end
            local ps=entity:GetDevicePS()
            local row={id=id,position=copy(at),open=ps:IsOpen()==true,locked=ps:IsLocked()==true,
                sealed=ps:IsSealed()==true,lift=ps:IsLiftDoor()==true}
            local who=entity.whoOpened
            row.openedByV=who~=nil and tostring(who:GetEntityID().hash)==own
            return entity,row
        end)
        if read and door then
            if info.locked or info.sealed or info.lift or not info.openedByV then
                skipped=info.lift and 'lift-door' or info.locked and 'locked' or info.sealed and 'sealed' or 'not-opened-by-V'
            else
                local distance=ground(info.position,from)
                if distance<bestDistance then best,bestInfo,bestDistance=door,info,distance end
            end
        end
    end
    if best then return best,bestInfo end
    return nil,skipped or 'no-door'
end

-- Opens a closed door with the same ToggleOpen action V's interaction uses.
function M.openDoor(player,door)
    local ok,result=pcall(function()
        local ps=door:GetDevicePS()
        if ps:IsOpen() then return 'already-open' end
        if ps:IsLocked() or ps:IsSealed() then return 'locked' end
        local action=ps:ActionToggleOpen()
        if not action then return 'no-action' end
        action:SetExecutor(player)
        Game.GetPersistencySystem():QueuePSDeviceEvent(action)
        return 'opened'
    end)
    if not ok then return false,'unavailable' end
    return result=='opened' or result=='already-open',result
end

-- A standing spot beside V inside a lift car, by physics alone. Live trace
-- 2026-10-08: the car floor carries no navmesh (the nearest walkable ground
-- was the doorway 2.8 m from V), so the navmesh placement refused every spot
-- in the car and Judy stood at the threshold for 65 s. A spot qualifies with
-- car floor under it at V's height, no wall between V and it, and room for
-- the body. Spots on the side facing `towards` (the companion at the door)
-- are tried first. `state` carries the search across updates; each call
-- spends at most carQueries physics queries, all through the shared budget. Returns spot, or nil,reason when none fits, or nil,nil,true
-- while the search continues.
-- Interior floors are Static or Dynamic collision (companion-seating.lua).
local floorGroups={'Static','Dynamic','Terrain'}
local wallGroups={'Static','Dynamic'}
local function floorAt(spatial,clearance,x,y,top,bottom)
    if not clearance.available(#floorGroups) then return nil,true end
    local best
    for _,group in ipairs(floorGroups) do
        clearance.take(1)
        local hit,trace=spatial:SyncRaycastByCollisionGroup(Vector4.new(x,y,top,1),Vector4.new(x,y,bottom,1),
            CName.new(group),false,false)
        if hit==true and trace and trace.position and (not best or trace.position.z>best) then best=trace.position.z end
    end
    return best
end
local function wallBetween(spatial,clearance,a,b)
    if not clearance.available(#wallGroups) then return nil,true end
    for _,group in ipairs(wallGroups) do
        clearance.take(1)
        -- nil is not proof of a clear line.
        if spatial:SyncRaycastByCollisionGroup(a,b,CName.new(group),false,false)~=false then return true end
    end
    return false
end
local function buildCandidates(state,v,towards)
    local dx,dy=towards.x-v.x,towards.y-v.y
    local length=math.sqrt(dx*dx+dy*dy)
    if length<.001 then dx,dy=0,1 else dx,dy=dx/length,dy/length end
    state.candidates,state.index={},1
    for _,radius in ipairs(M.policy.carRings) do
        for _,step in ipairs({0,1,-1,2,-2,3,-3,4}) do
            local co,si=math.cos(step*math.pi/4),math.sin(step*math.pi/4)
            state.candidates[#state.candidates+1]={x=v.x+(dx*co-dy*si)*radius,
                y=v.y+(dy*co+dx*si)*radius,ux=dx*co-dy*si,uy=dy*co+dx*si}
        end
    end
end
function M.carSpot(state,v,towards,occupied,body,clearance)
    if not state.candidates then buildCandidates(state,v,towards) end
    local ok,spot,reason,pending=pcall(function()
        local spatial=Game.GetSpatialQueriesSystem()
        if not spatial then return nil,'physics-unavailable' end
        local spent=0
        if not state.floor then
            -- No car floor seen under V's own feet: nothing beside V will do.
            local floor,wait=floorAt(spatial,clearance,v.x,v.y,v.z+.9,v.z-.6)
            if wait then return nil,nil,true end
            if not floor or math.abs(floor-v.z)>M.policy.carFloor then return nil,'no-car-floor' end
            state.floor,spent=floor,#floorGroups
        end
        while state.index<=#state.candidates and spent<M.policy.carQueries do
            local c=state.candidates[state.index]
            local free=true
            for _,other in ipairs(occupied or {}) do
                local at=other.position or other
                if at and at.x and ground(c,at)<.9 then free=false; break end
            end
            if free then
                spent=spent+#floorGroups
                local floor,wait=floorAt(spatial,clearance,c.x,c.y,v.z+.9,v.z-.6)
                if wait then return nil,nil,true end
                if floor and math.abs(floor-v.z)<=M.policy.carFloor then
                    -- From just outside V's own body to the spot, at waist height.
                    spent=spent+#wallGroups
                    local wall
                    wall,wait=wallBetween(spatial,clearance,Vector4.new(v.x+c.ux*.35,v.y+c.uy*.35,v.z+1,1),
                        Vector4.new(c.x,c.y,floor+1,1))
                    if wait then return nil,nil,true end
                    if wall==false then
                        spent=spent+6
                        local feet=Vector4.new(c.x,c.y,floor,1)
                        local fits,_,deferred=clearance.body(feet,body)
                        if deferred then return nil,nil,true end
                        if fits then return Vector4.new(c.x,c.y,floor+.05,1) end
                    end
                end
            end
            state.index=state.index+1
        end
        if state.index>#state.candidates then return nil,'no-car-floor' end
        return nil,nil,true
    end)
    if not ok then return nil,'physics-unavailable' end
    return spot,reason,pending
end

-- Where V stepped out of the car: V's newest foothold on the companion's
-- floor within `reach` of her, or nil.
function M.exitPoint(trail,from,reach)
    for index=#trail,1,-1 do
        local point=trail[index]
        if math.abs(point.z-from.z)<.8 and ground(point,from)<=reach then return copy(point) end
    end
end

-- V's recent footholds, newest last. Points taken inside a lift car are
-- skipped: the car leaves with V.
function M.trailPush(trail,position,clock,excluded)
    if excluded then return end
    local last=trail[#trail]
    if last and ground(last,position)<M.policy.trailSpacing and math.abs(last.z-position.z)<.5 then return end
    trail[#trail+1]={x=position.x,y=position.y,z=position.z,at=clock}
    if #trail>M.policy.trailLength then table.remove(trail,1) end
end
-- Newest footholds on V's floor, between `near` and `far` metres from V.
function M.trailPoints(trail,position,near,far,limit)
    local result={}
    for index=#trail,1,-1 do
        local point=trail[index]
        local gap=ground(point,position)
        if math.abs(point.z-position.z)<1 and gap>=near and gap<=far then
            result[#result+1]=point
            if #result>=limit then break end
        end
    end
    return result
end

-- Optional native path -----------------------------------------------------------------------
-- With the CyberpunkConvaiNative plugin loaded and its 'passage' switch on, carSpot runs its
-- physics loop in C++ (native/core/src/systems/passage): one CET call per update instead of up to
-- 24 units of floor and wall rays and body overlaps (about 40 Vector4.new/CName.new/query calls).
-- "Car" here is a LIFT car; nothing in this file reads vehicle seats. Everything above is the
-- original Lua and stays the fallback:
--   * kill switch: a line "passage" in runtime/native-off.txt, or convaiNative.off('passage') in the
--     CET console; three faults inside the plugin's natives also switch it off;
--   * the search state (candidate list, next index, car floor) and the per-update query budget stay
--     Lua tables: the plugin is told what is left and reports the queries it issued, which are added
--     to the budget through clearance.spend (a clearance module without remaining/spend runs the Lua);
--   * a native call that fails or answers unreadably calls convaiNative.fail('passage', ...): this
--     module stays on Lua for the session and probe.log says why. A game query that fails inside the
--     plugin does the same, after the queries it made are charged;
--   * before the first use the plugin runs its own queries in the world (SelfTest); 'wait' means no
--     world yet (the Lua runs and the proof is retried in 2 s);
--   * the first VERIFY answers also run the original on the same state and budget, compare spot,
--     reason, state and queries used, and fail on any difference (the original's result is used).
--     convaiNative.passageVerify = true compares every call; convaiNative.passageStats counts them.
-- Wire format: PassageCore.hpp.
local NATIVE='passage' -- the convaiNative system name (kill switch, probe.log)
local VERIFY=8
local BIG=1000000
local luaCarSpot=M.carSpot

local function bound(value) return type(value)=='table' or type(value)=='userdata' end
local nativeClass
local function resolve()
    if nativeClass then return nativeClass end
    local ok,class=pcall(function() return ConvaiNativePassage end)
    if ok and bound(class) then nativeClass=class end
    return nativeClass
end
local function note(line)
    pcall(function()
        local file=io.open('runtime/probe.log','a')
        if file then file:write(os.date('!%Y-%m-%dT%H:%M:%SZ'),' ',line,'\n'); file:close() end
    end)
end
local function stats(api)
    local row=api.passageStats
    if type(row)~='table' then
        row={native=0,lua=0,fallback=0,verified=0,compared=0,mismatches=0}
        api.passageStats=row
    end
    return row
end
local function finite(value) return type(value)=='number' and value==value and math.abs(value)<10000000 end
local function number(token)
    if token=='nan' then return 0/0 end
    if token=='inf' then return math.huge end
    if token=='-inf' then return -math.huge end
    return tonumber(token)
end

-- true once the plugin's game access is proven in this session.
local function proven(class,api)
    if api.passageProven then return true end
    local now=os.clock()
    if api.passageRetry and now<api.passageRetry then return false end
    local ok,text=pcall(function() return class.SelfTest() end)
    text=ok and tostring(text) or ('error: '..tostring(text))
    if text:sub(1,4)=='wait' then
        -- No world yet, or a lookup that never works: five waits in a row count as a failure.
        api.passageWaits=(api.passageWaits or 0)+1
        if api.passageWaits>5 then api.fail(NATIVE,'self-test: '..text); return false end
        api.passageRetry=now+2
        return false
    end
    if text~='ok' then api.fail(NATIVE,'self-test: '..text); return false end
    api.passageProven=true
    note('Native core: passage self-test passed (game queries work in the world)')
    return true
end

-- "x y ux uy " for every candidate, built once per search.
local function candidateText(state)
    local parts={}
    for index,c in ipairs(state.candidates) do
        parts[index]=('%.17g %.17g %.17g %.17g'):format(c.x,c.y,c.ux,c.uy)
    end
    return table.concat(parts,' ')
end
-- "x y " for every occupied position the original would measure; nil when the list holds something
-- the plugin cannot take (the original then decides what to do with it).
local function occupiedText(occupied)
    local parts={}
    for _,other in ipairs(occupied or {}) do
        local at=other.position or other
        if at and at.x then
            if not (finite(at.x) and finite(at.y)) then return nil end
            parts[#parts+1]=('%.17g %.17g'):format(at.x,at.y)
        end
    end
    return table.concat(parts,' ')
end

-- "<status> <used> ..." as numbers, or nil.
local function decode(text)
    if type(text)~='string' then return nil end
    local f,count={},0
    for token in text:gmatch('%S+') do
        count=count+1
        f[count]=number(token)
        if f[count]==nil then return nil end
    end
    local status=f[1]
    local want={[0]=9,[1]=7,[2]=6,[4]=3}
    if want[status]~=count then return nil end
    return f
end

local function sameSpot(a,b)
    if a==nil or b==nil then return a==b end
    return math.abs(a.x-b.x)<1e-4 and math.abs(a.y-b.y)<1e-4 and math.abs(a.z-b.z)<1e-4
end

-- Calls the plugin with the search state as it is now. Returns the decoded fields, or nil plus a
-- reason ('lua': run the original, no failure; 'failed': the system was switched off).
local function ask(class,api,state,v,occupied,body,clearance)
    if not (finite(v.x) and finite(v.y) and finite(v.z)) then return nil,'lua' end
    local radius,height=.4,2.1
    if body then
        if not (finite(body.radius) and finite(body.height)) then return nil,'lua' end
        radius,height=body.radius,body.height
    end
    local policy=M.policy
    if not (finite(policy.carFloor) and math.floor(policy.carQueries)==policy.carQueries) then return nil,'lua' end
    local others=occupiedText(occupied)
    if not others then return nil,'lua' end
    local candidates=state.nativeCandidates
    if not candidates or state.nativeCandidatesFor~=state.candidates then
        candidates=candidateText(state)
        state.nativeCandidates,state.nativeCandidatesFor=candidates,state.candidates
    end
    local left=clearance.remaining()
    local ok,text=pcall(class.CarSpot,v.x,v.y,v.z,candidates,others,radius,height,policy.carQueries,
        policy.carFloor,left,state.index,state.floor~=nil,state.floor or 0)
    if not ok then api.fail(NATIVE,'carSpot: '..tostring(text)); return nil,'failed' end
    if text=='' then return nil,'lua' end -- unreadable arguments (not a game failure): the original decides
    local f=decode(text)
    if not f then api.fail(NATIVE,'carSpot: unreadable reply '..tostring(text)); return nil,'failed' end
    if f[1]==4 then
        -- The plugin's game call failed. Queries it already made still count against this update.
        clearance.spend(f[2],false)
        api.fail(NATIVE,'carSpot: game query failed (code '..tostring(f[3])..')')
        return nil,'failed'
    end
    return f,text
end

function M.carSpot(state,v,towards,occupied,body,clearance)
    local api=convaiNative
    if type(api)~='table' or type(api.use)~='function' or api.use(NATIVE)~=true then
        return luaCarSpot(state,v,towards,occupied,body,clearance)
    end
    local class=resolve()
    if not class then
        api.fail(NATIVE,'ConvaiNativePassage is not registered')
        return luaCarSpot(state,v,towards,occupied,body,clearance)
    end
    if type(clearance)~='table' or type(clearance.remaining)~='function' or type(clearance.spend)~='function'
        or type(clearance.spent)~='function' or not proven(class,api) then
        return luaCarSpot(state,v,towards,occupied,body,clearance)
    end
    local row=stats(api)
    if not state.candidates then buildCandidates(state,v,towards) end
    local f,why=ask(class,api,state,v,occupied,body,clearance)
    if not f then
        row[why=='failed' and 'fallback' or 'lua']=row[why=='failed' and 'fallback' or 'lua']+1
        return luaCarSpot(state,v,towards,occupied,body,clearance)
    end
    local status=f[1]
    local used,deferred,index,hasFloor,floor=f[2],f[3]==1,f[4],f[5]==1,f[6]
    local spot,reason,pending
    if status==0 then spot=Vector4.new(f[7],f[8],f[9],1)
    elseif status==1 then reason=f[7]==1 and 'no-car-floor' or 'physics-unavailable'
    else pending=true end

    if api.passageVerify==true or row.verified<VERIFY then
        -- Both paths on the same state and budget; the original's answer is the one used.
        local budgeted=clearance.remaining()<BIG
        local usedBefore,deferredBefore=clearance.spent()
        local lSpot,lReason,lPending=luaCarSpot(state,v,towards,occupied,body,clearance)
        local usedAfter,deferredAfter=clearance.spent()
        row.compared=row.compared+1
        local same=sameSpot(spot,lSpot) and reason==lReason and (pending==true)==(lPending==true)
            and state.index==index and (state.floor~=nil)==hasFloor
            and (not hasFloor or math.abs(state.floor-floor)<1e-4)
            and (not budgeted or (usedAfter-usedBefore==used and (deferredAfter-deferredBefore==1)==deferred))
        if not same then
            row.mismatches=row.mismatches+1
            note(('Native core: passage MISMATCH: plugin status %d used %d index %d floor %s, Lua spot=%s reason=%s '
                ..'pending=%s index %s used %s'):format(status,used,index,tostring(hasFloor and floor),
                tostring(lSpot~=nil),tostring(lReason),tostring(lPending),tostring(state.index),
                tostring(usedAfter-usedBefore)))
            api.fail(NATIVE,'carSpot differs from the Lua')
        else
            row.verified=row.verified+1
            if row.verified==VERIFY then note('Native core: passage carSpot matched the Lua '..VERIFY..' times, now native') end
        end
        return lSpot,lReason,lPending
    end

    row.native=row.native+1
    clearance.spend(used,deferred)
    state.index=index
    state.floor=hasFloor and floor or nil
    return spot,reason,pending
end

-- Developer mode (perf-probe) times the entry point as passage.carSpot, so the two paths can be
-- compared with convaiNative.off('passage') / convaiNative.on('passage').
local probe=convaiPerfProbe
if type(probe)=='table' and type(probe.watch)=='function' then
    pcall(probe.watch,M,'carSpot','passage.carSpot')
end
return M
