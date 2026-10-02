-- A transaction inside companion-vehicles' movement/seat owner. There is no
-- update registration here and no independent NPC controller.
local M={}
local RELEASE_TIMEOUT,BOARD_TIMEOUT,START_TIMEOUT=12,25,5
local STOP_TIMEOUT,PARTY_TIMEOUT,TRIP_TIMEOUT,STALL_TIMEOUT=15,75,1800,35
local PLAYER_WAIT_TIMEOUT,PLAYER_WAIT_DISTANCE=300,40
local DRIVER_SEAT_GRACE=45
local ARRIVAL_DISTANCE,RETARGET_INTERVAL=7,0.2
local passengerSeats={'seat_front_right','seat_back_left','seat_back_right'}
local function copy(value)
    if type(value)~='table' then return value end
    local result={}; for key,item in pairs(value) do result[key]=copy(item) end; return result
end
local function safe(fn,...)
    local ok,a,b=pcall(fn,...); if not ok then return nil,tostring(a) end; return a,b
end
local function samePoint(a,b)
    return a and b and math.abs(a.x-b.x)<0.25 and math.abs(a.y-b.y)<0.25 and math.abs(a.z-b.z)<0.25
end
local function sameDestination(a,b)
    if not a or not b or a.id~=b.id or a.destinationType~=b.destinationType then return false end
    return a.destinationType=='Quest' or (a.destinationType=='PlayerTracked'
        and samePoint(a.markerPosition,b.markerPosition))
end
local function terminal(state)
    return state=='Success' or state=='Failure' or state=='Cancelled'
        or state=='Interrupted' or state=='Detached'
end
local function destination(c,value)
    if not value then return false,'The map destination is no longer selected.' end
    local old=c.destinationAnchor or c.waypoint
    local changed=not sameDestination(old,value) or not old or not old.position
        or math.abs(old.position.x-value.position.x)>1 or math.abs(old.position.y-value.position.y)>1
        or math.abs(old.position.z-value.position.z)>1
    c.waypoint=copy(value)
    if changed then
        c.destinationRevision=(c.destinationRevision or 1)+1
        c.destinationAnchor=copy(value)
    end
    return true
end
local function bounded(value,fallback,limit)
    local text=type(value)=='string' and value or fallback
    if text=='' then text=fallback end
    text=text:gsub('[%c]',' '); return text:sub(1,limit)
end
local function publicOffer(sample)
    local actor=sample.actor or {}
    local offer={available=false,actor={serial=actor.serial,id=actor.id,key=actor.key}}
    if sample.car then offer.car={id=sample.car.id,record=bounded(sample.car.record,'Vehicle',256),
        name=bounded(sample.car.name,sample.car.record or 'Your car',160)} end
    if sample.waypoint then offer.waypoint={id=sample.waypoint.id,position=copy(sample.waypoint.position),
        name=bounded(sample.waypoint.name,'Selected destination',160)} end
    return offer
end
local function reject(offer,code,reason) offer.code,offer.reason=code,reason; return offer end
local function seat(info,name)
    for _,row in ipairs(info and info.seats or {}) do if row.name==name then return row end end
end
local function free(info,name) local row=seat(info,name); return row and not row.occupant and not row.reserved end
local function preparation(phase)
    return phase=='releasing' or phase=='boarding-driver' or phase=='waiting-for-driver-seat'
        or phase=='waiting-for-player' or phase=='waiting-for-party'
end
local function approaching(phase)
    return phase=='releasing' or phase=='boarding-driver' or phase=='waiting-for-driver-seat'
end
local function offer(s,player,entry)
    local sample,err=safe(s.chauffeurApi.sample,player,entry,nil,s.api)
    if not sample then return {available=false,code='world-unavailable',reason='Vehicle information is not ready.',error=err} end
    local value=publicOffer(sample)
    if sample.playerMount then
        if sample.playerMount.seat=='seat_front_left' then
            return reject(value,'player-driving','Step out of the driver seat before asking your companion to drive.'),sample
        end
        return reject(value,'player-seated','Step out before starting a new companion trip.'),sample
    end
    if s.chauffeur or s.phase~='on-foot' then return reject(value,'transport-busy','Wait for the current vehicle activity to finish.'),sample end
    for _,person in pairs(s.people) do if person.owned then return reject(value,'transport-busy','Wait for the current vehicle activity to finish.'),sample end end
    if not sample.actorValid or not sample.actor.id or type(sample.actor.key)~='string' or sample.actor.key=='' then
        return reject(value,'actor-unavailable','This managed companion is unavailable.'),sample
    end
    if sample.driverMount then return reject(value,'actor-seated','Your companion must step out before taking the driver seat.'),sample end
    if not sample.actorCalm or sample.playerCombat then return reject(value,'combat','Finish combat before asking for a ride.'),sample end
    if sample.auto.enabled then return reject(value,'autodrive-active','An AutoDrive journey is already active.'),sample end
    if not sample.car or not sample.carValid or sample.car.id~=sample.summonedId then
        return reject(value,'no-summoned-car','Summon one of your owned cars first.'),sample
    end
    if not sample.info.ready or sample.info.invalid or sample.summonEnRoute then
        return reject(value,'car-arriving','Wait for your summoned car to arrive.'),sample
    end
    if not sample.drive or not sample.drive.known or not sample.drive.ready then
        return reject(value,'driving-unavailable','Vehicle driving AI is not ready.'),sample
    end
    if sample.drive.foreign or sample.drive.busy then
        return reject(value,'transport-busy','Another vehicle activity has control.'),sample
    end
    if sample.info.speed>0.5 or sample.info.scene then return reject(value,'car-moving','Wait for your car to stop.'),sample end
    if (sample.info.playerGap or math.huge)>20 then return reject(value,'car-distant','Stand near your summoned car.'),sample end
    if not sample.waypoint then return reject(value,'no-waypoint','Select a destination on the map first.'),sample end
    if not free(sample.info,'seat_front_left') then return reject(value,'driver-occupied','The driver seat is occupied or reserved.'),sample end
    for _,name in ipairs(passengerSeats) do if free(sample.info,name) then value.passengerSeat=name; break end end
    if not value.passengerSeat then return reject(value,'no-passenger-seat','Your car has no free passenger seat for V.'),sample end
    value.available=true
    return value,sample
end
function M.offer(s,player,entry) local value=offer(s,player,entry); return copy(value) end
local function matches(a,b)
    return type(a)=='table' and a.available==true and a.actor and a.car and a.waypoint
        and a.actor.serial==b.actor.serial and a.actor.id==b.actor.id and a.actor.key==b.actor.key
        and a.car.id==b.car.id and a.car.record==b.car.record and a.waypoint.id==b.waypoint.id
        and samePoint(a.waypoint.position,b.waypoint.position) and a.passengerSeat==b.passengerSeat
end
local function phase(s,value)
    local c=s.chauffeur; c.phase=value; c.phaseAt=s.clock
    if value=='exiting-driver' and not c.exitPrepared then
        c.exitPrepared=true
        for _,person in pairs(s.people) do person.phase='leaving'; person.attempts=0; person.retryAt=nil end
    end
    s.phase=(value=='driving' or value=='waiting-for-player-exit') and 'riding' or 'chauffeur'
end
function M.queue(s,player,entry,expected)
    local value,sample=offer(s,player,entry)
    if not value.available then return false,value.reason,value end
    if expected and not matches(expected,value) then return false,'The companion, car, seat or selected destination changed. Ask again.',value end
    s.generation=s.generation+1
    s.primary=sample.car -- borrowed: deliberately never added to the owned cars list
    s.people[entry.serial]={entry=entry,phase='releasing',attempts=0,owned=true,chauffeur=true,
        vehicle=s.primary,seat='seat_front_left'}
    s.chauffeur={phase='releasing',phaseAt=s.clock,startedAt=s.clock,offer=copy(value),entry=entry,player=player,
        car=s.primary,serial=entry.serial,waypoint=copy(sample.waypoint),passengerSeat=value.passengerSeat,
        playerId=sample.playerId,generation=s.generation,active=true,stopAttempts=0,brakeAttempts=0,
        destinationRevision=1,destinationAnchor=copy(sample.waypoint),driveRevision=0,retargets=0,backend='npc'}
    s.lastChauffeur=nil; s.phase='chauffeur'; s.error=nil
    return true,'Your companion is preparing to drive.',copy(value)
end
local function stop(s,reason,outcome)
    local c=s.chauffeur
    if c.phase=='stopping' or c.phase=='waiting-for-player-exit' or c.phase=='exiting-driver' then return end
    c.reason=reason; c.outcome=outcome or 'cancelled'; phase(s,'stopping')
end
function M.cancel(s,reason)
    if not s.chauffeur then return false,'There is no companion trip to cancel.' end
    s.chauffeur.cancelled=true
    stop(s,reason or 'Trip cancelled.','cancelled'); return true
end
function M.canDismiss(s,serial)
    if s.chauffeur and s.chauffeur.serial==serial then
        return false,'Stop the trip and step out before dismissing your driver.'
    end
    return true
end
local function retire(s,c)
    if c.operation and not c.stopConfirmed and c.stopAttempts<3 and s.clock>=(c.stopAt or 0) then
        local prior=c.operation.cancelRequested
        c.stopAt=s.clock+1
        local done,why=safe(s.chauffeurApi.stop,c.operation,c.car)
        if c.operation.stopSubmissions then c.stopAttempts=c.operation.stopSubmissions
        elseif c.operation.cancelRequested and not prior then c.stopAttempts=c.stopAttempts+1 end
        if done then c.stopConfirmed=true elseif why then c.error=why end
    end
    -- Native completion/collision interruption does not erase the fixed-car
    -- stop obligation. The adapter rechecks foreign control before braking.
    if c.stopObligation and c.brakeAttempts<3 and s.clock>=(c.brakeAt or 0) then
        c.brakeAt=s.clock+4
        local done,why=safe(s.chauffeurApi.brake,c.car,c.operation)
        if done~=false then c.brakeAttempts=c.brakeAttempts+1 end
        if not done and why then c.error=why end
    end
end
function M.prepareShutdown(s,reason)
    local c=s.chauffeur
    if not c then return true end
    stop(s,reason or 'The mod is stopping. Step out before dismissing your driver.','cancelled')
    if not c.shutdownNativeAttempt then
        c.shutdownNativeAttempt=true
        retire(s,c)
    end
    -- Reload cannot wait for player exit. Return a plain cleanup receipt and
    -- retain the live owner; the caller must not delete this driver or pretend
    -- that a new Lua instance can automatically recover its native commands.
    return false,'The driver remains protected until V exits and cleanup finishes.',
        {actor=copy(c.offer.actor),car=copy(c.offer.car),passengerSeat=c.passengerSeat,
            phase=c.phase,backend='npc',vehicleCommand=safe(s.chauffeurApi.driveReceipt,c.operation),
            nativeStopRequested=c.operation and c.operation.cancelRequested==true or false}
end
function M.autodriveToggled(s,enabled)
    local c=s.chauffeur
    if c and enabled then stop(s,'Another AutoDrive activity took control.','cancelled') end
end
function M.arrived(s,vehicleId)
    -- AutoDrive arrival is foreign to this backend. Only the owned NPC command
    -- and the current destination's physical arrival evidence can complete it.
    return false
end
local function binding(c,sample,requirePassenger,clearedAtArrival)
    if not sample.actorValid or sample.actor.id~=c.offer.actor.id or sample.actor.key~=c.offer.actor.key then
        return false,'The companion binding changed.'
    end
    if not sample.actorCalm or sample.playerCombat then return false,'The trip stopped for combat.' end
    if not sample.carValid or not sample.car or sample.car.id~=c.car.id then return false,'The borrowed car is unavailable.' end
    if sample.info.scene then return false,'A scene has taken control of the car.' end
    if sample.summonedId~=c.car.id then return false,'A different car was summoned.' end
    if not clearedAtArrival then
        local route,why=destination(c,sample.waypoint)
        if not route then return false,why end
    end
    local pm=sample.playerMount
    if pm and (pm.vehicle~=c.car.id or (pm.seat~=c.passengerSeat
        and not (approaching(c.phase) and pm.seat=='seat_front_left')
        and not (preparation(c.phase) and c.passengerYieldPending))) then return false,'V changed seats or vehicles.' end
    if requirePassenger and (not pm or not sample.playerPassenger) then return false,'V left the passenger seat.' end
    return true
end
local function driverSeated(c,sample)
    local mount=sample.driverMount
    return mount and mount.vehicle==c.car.id and mount.seat=='seat_front_left'
end
local function finish(s,c)
    s.lastChauffeur=M.snapshot(s)
    s.lastChauffeur.active=false; s.lastChauffeur.phase=c.outcome or 'cancelled'
    s.people={}; s.chauffeur=nil; s.primary=nil
    s.phase='on-foot'; s.replan=nil; s.error=nil
end
function M.update(s,player,entries,hooks,ops)
    local c=s.chauffeur
    local person=s.people[c.serial]
    local present=false
    for _,entry in ipairs(entries) do
        if entry.serial==c.serial and tostring(entry.entityID.hash)==c.offer.actor.id then present=true; c.entry=entry; break end
    end
    if person and present then person.entry=c.entry end
    if not present or not person or person.removing then stop(s,'The selected companion is leaving.','cancelled') end
    local sample,err=safe(s.chauffeurApi.sample,player,c.entry,c.car,s.api,c.operation)
    if not sample then
        stop(s,'Vehicle information became unavailable.','failed')
        -- Waypoint/UI reads can fail independently of the exact native vehicle
        -- binding. The stop adapter rechecks that binding itself, so one bad
        -- observation must not leave an owned car driving indefinitely.
        retire(s,c)
        c.error=err or 'Waiting for current vehicle information.'; return
    end
    local drive=sample.drive or {known=false,error='Vehicle driving information is unavailable.'}
    c.observed={enabled=sample.auto.enabled,commandState=drive.state,commandId=drive.commandId,
        commandOwned=drive.ownedActive,foreign=drive.foreign,remaining=drive.remaining,distance=drive.distance,
        speed=sample.info.speed,playerSeat=sample.playerMount and sample.playerMount.seat,
        driverSeat=sample.driverMount and sample.driverMount.seat}
    if sample.car and sample.car.id==c.car.id then
        c.car.entity=sample.car.entity; c.car.info=sample.info
    end
    if person then person.mount=sample.driverMount end
    -- Transport acquired the selected actor at queue admission. Retire its
    -- exact foot/look/equipment owners even if a route or seat race changes
    -- the phase before the ordinary releasing branch can run. A foreign or
    -- detached actor is never serviced through this handoff.
    local prepared=person and present and not person.removing and sample.actorValid
        and ops.prepare(s,person,hooks)
    local takingOver=sample.playerMount and sample.playerMount.vehicle==c.car.id
        and sample.playerMount.seat=='seat_front_left'
    local stopped=sample.info.ready and sample.info.speed<=0.5 and not sample.info.scene
    local driverGrace=approaching(c.phase) and not c.operation
        and not sample.auto.enabled and stopped
    if takingOver and driverGrace then
        -- People can choose the wrong door while their friend is approaching.
        -- Yield the exact NPC mount and wait; an accidental stopped-car entry
        -- is not a new request, nor permission to move V to another seat.
        if not c.driverSeatWaitStarted then
            c.driverSeatWaitStarted=s.clock
            c.driverSeatWaitUsed=0
        end
        if c.phase~='waiting-for-driver-seat' then
            c.driverSeatWaitAt=s.clock
            phase(s,'waiting-for-driver-seat')
        end
    elseif takingOver then
        c.yieldToPlayer=true
        stop(s,'You are driving. The companion trip was cancelled.','taken-over')
    end
    if sample.auto.enabled or drive.foreign then
        stop(s,'Another AutoDrive activity took control.','cancelled')
    end
    if c.phase~='stopping' and c.phase~='waiting-for-player-exit' and c.phase~='exiting-driver' then
        -- Custom markers can clear on arrival. The same owned command must
        -- have finished and physically stopped near its last applied target;
        -- marker removal while driving still cancels normally.
        local clearedAtArrival=c.phase=='driving' and not sample.waypoint
            and drive.known and drive.state=='Success' and stopped
            and type(drive.distance)=='number' and drive.distance<=ARRIVAL_DISTANCE
            and c.driveRevision==c.destinationRevision and not c.cancelled
        local ok,reason=binding(c,sample,c.phase=='waiting-for-party' or c.phase=='starting' or c.phase=='driving',clearedAtArrival)
        if not ok then stop(s,reason,'cancelled') end
        if not approaching(c.phase) and not driverSeated(c,sample) then
            stop(s,'The companion left the driver seat.','cancelled')
        end
        if preparation(c.phase) and not sample.playerMount and sample.info.ready
            and (sample.info.playerGap or 0)>PLAYER_WAIT_DISTANCE then
            stop(s,'You moved away from the car. The trip was cancelled.','cancelled')
        end
    end
    local age=s.clock-c.phaseAt
    if c.phase=='releasing' then
        if prepared then phase(s,'boarding-driver')
        elseif age>RELEASE_TIMEOUT then stop(s,'Walking commands did not release in time.','failed') end
    elseif c.phase=='boarding-driver' then
        ops.board(s,person,hooks,1)
        if person.phase=='riding' and driverSeated(c,sample) then phase(s,'waiting-for-player')
        elseif age>BOARD_TIMEOUT then stop(s,'The companion could not finish entering the driver seat.','failed') end
    elseif c.phase=='waiting-for-driver-seat' then
        local released=ops.pauseDriver(s,person,hooks)
        local used=(c.driverSeatWaitUsed or 0)+s.clock-(c.driverSeatWaitAt or s.clock)
        local driverSeat=seat(sample.info,'seat_front_left')
        if used>=DRIVER_SEAT_GRACE then
            stop(s,'The driver seat was not released, so the trip was cancelled.','cancelled')
        elseif not takingOver and (not stopped or sample.auto.enabled) then
            -- A moving/foreign AutoDrive car is no longer a preparation pause.
            -- The stop path retains ownership without braking another owner.
            stop(s,'The car is now in use. The companion trip was cancelled.','cancelled')
        elseif not takingOver and released and driverSeat and not driverSeat.occupant and not driverSeat.reserved then
            c.driverSeatWaitUsed=used; c.driverSeatWaitAt=nil; c.error=nil
            phase(s,'boarding-driver')
        else
            c.error=takingOver and 'Step out of the driver seat so your companion can get in.'
                or 'Waiting for the native vehicle transition to finish.'
        end
    elseif c.phase=='waiting-for-player' then
        local pm=sample.playerMount
        if pm and pm.vehicle==c.car.id and pm.seat==c.passengerSeat and sample.playerPassenger
            and not c.passengerYieldPending then
            c.error=nil
            phase(s,'waiting-for-party')
        elseif age>PLAYER_WAIT_TIMEOUT then
            stop(s,'You did not board the car, so the trip was cancelled.','cancelled')
        elseif c.passengerYieldPending then
            c.error='Waiting for your passenger seat to be released.'
        else c.error=nil
        end
    elseif c.phase=='waiting-for-party' then
        if c.partyReady and not c.passengerYieldPending then phase(s,'starting')
        elseif age>PARTY_TIMEOUT then stop(s,'The party could not finish boarding. The trip was cancelled.','failed') end
    elseif c.phase=='starting' then
        if c.operation then
            if drive.known and drive.ownedActive and (drive.state=='Executing' or drive.state=='Enqueued') then
                c.progressAt=s.clock; c.drivingAt=c.drivingAt or s.clock
                c.lastRemaining=drive.remaining; phase(s,'driving')
            elseif drive.known and terminal(drive.state) then
                stop(s,'The native driving command ended before departure.','failed')
            elseif age>START_TIMEOUT then stop(s,'Native NPC driving did not start in time.','failed') end
        else
            if not sample.auto.laneValid or not drive.known or not drive.ready or drive.foreign
                or drive.busy or drive.reservations~=0 then
                stop(s,'NPC driving cannot start on this road or while the car is in use.','failed')
            else
                local operation,why=safe(s.chauffeurApi.start,player,c.entry,c.car,c.waypoint,c.passengerSeat,s.api)
                if operation then
                    c.operation=operation; c.stopObligation=true; c.driveRevision=c.destinationRevision
                    c.commandReceipt=safe(s.chauffeurApi.driveReceipt,operation)
                    if operation.refused or operation.sendError then
                        stop(s,why or 'The native driving submission could not be confirmed.','failed')
                    end
                else stop(s,why or 'Native NPC driving did not accept departure.','failed') end
            end
        end
    elseif c.phase=='driving' then
        if not drive.known then stop(s,drive.error or 'The driving command is unavailable.','failed')
        elseif drive.state=='Success' then
            -- A new selected destination can race the end of the old command.
            -- Preserve the trip and submit its next revision only after the old
            -- command is terminal and the borrowed car is physically stopped.
            if not stopped then
                if c.brakeAttempts<3 and s.clock>=(c.brakeAt or 0) then
                    c.brakeAttempts=c.brakeAttempts+1; c.brakeAt=s.clock+4
                    safe(s.chauffeurApi.brake,c.car,c.operation)
                end
                c.successAt=c.successAt or s.clock
                if s.clock-c.successAt>STOP_TIMEOUT then stop(s,'The car did not stop after its route ended.','failed') end
            elseif c.driveRevision~=c.destinationRevision then
                c.operation=nil; c.commandReceipt=nil; c.successAt=nil
                c.stopAttempts=0; c.brakeAttempts=0; c.brakeAt=nil
                phase(s,'starting')
            elseif type(drive.distance)=='number' and drive.distance<=ARRIVAL_DISTANCE and not c.cancelled then
                stop(s,'Destination reached. Step out when ready.','completed')
            else stop(s,'The route ended before reaching the selected destination.','failed') end
        elseif terminal(drive.state) then
            stop(s,'The native driving command was interrupted. Step out when ready.','stopped')
        elseif not drive.ownedActive then
            stop(s,'The driving command lost its exact owner.','failed')
        else
            if c.driveRevision~=c.destinationRevision and s.clock>=(c.retargetAt or 0) then
                c.retargetAt=s.clock+RETARGET_INTERVAL
                local done,why=safe(s.chauffeurApi.retarget,c.operation,c.car,c.waypoint)
                if done then
                    c.driveRevision=c.destinationRevision; c.retargets=c.retargets+1
                    c.progressAt=s.clock; c.lastRemaining=nil
                else stop(s,why or 'The driving destination could not be updated.','failed') end
            end
            local remaining=drive.remaining
            if type(remaining)=='number' and remaining>=0 then
                -- Native distance is a local traffic-slot path, which can
                -- start at zero and reset upward when its next segment loads.
                if not c.lastRemaining or remaining<c.lastRemaining-2 then c.progressAt=s.clock end
                c.lastRemaining=remaining
            end
            if sample.info.ready and sample.info.speed>0.3 then c.progressAt=s.clock end
            if s.clock-(c.progressAt or s.clock)>STALL_TIMEOUT then stop(s,'The route is blocked. Step out or try a new trip.','failed')
            elseif s.clock-(c.drivingAt or c.startedAt)>TRIP_TIMEOUT then stop(s,'The trip exceeded its time limit.','failed') end
        end
    end
    if c.phase=='stopping' then
        local other=sample.auto.enabled or drive.foreign
        local pm=sample.playerMount
        local takeover=pm and pm.vehicle==c.car.id and pm.seat=='seat_front_left'
        -- Retire only our exact command even if a different owner has taken the
        -- car. Its adapter never brakes V, a scene or a foreign command.
        if not sample.info.scene then retire(s,c) end
        local retired=not c.operation or drive.known and terminal(drive.state)
        if not sample.car and not sample.driverMount and (not pm or pm.vehicle~=c.car.id) then retired=true end
        if other and c.yieldToPlayer and takeover then
            -- V started another native driving activity during preparation.
            -- Retire only the NPC request and yield, without touching that
            -- activity, steering/braking V, or recreating chauffeur intent.
            if retired and ops.yieldToPlayer(s,player,hooks) then
                s.lastChauffeur=M.snapshot(s); s.lastChauffeur.active=false; s.lastChauffeur.phase='taken-over'
                s.chauffeur=nil
            else c.error='Waiting for the companion to release the driver seat.' end
            return
        end
        if other then c.error='Waiting for the other vehicle activity to finish.'; return end
        if sample.info.scene then c.error='Waiting for the vehicle scene to finish.'; return end
        if retired then
            if c.yieldToPlayer and takeover then
                if ops.yieldToPlayer(s,player,hooks) then
                    s.lastChauffeur=M.snapshot(s); s.lastChauffeur.active=false; s.lastChauffeur.phase='taken-over'
                    s.chauffeur=nil
                else c.error='Waiting for the companion to release the driver seat.' end
                return
            end
            if sample.info.ready and sample.info.speed<=0.5 and not sample.info.scene then
                c.error=nil
                if pm and pm.vehicle==c.car.id then phase(s,'waiting-for-player-exit')
                else phase(s,'exiting-driver') end
            elseif not sample.car and not sample.driverMount then phase(s,'exiting-driver') end
        end
        if s.clock-c.phaseAt>STOP_TIMEOUT then c.error=c.error or 'Waiting for the owned driving command to retire and the car to stop.' end
    elseif c.phase=='waiting-for-player-exit' then
        if sample.auto.enabled or drive.foreign then c.error='Finish the active vehicle activity before your companion gets out.'; return end
        if not sample.playerMount or sample.playerMount.vehicle~=c.car.id then phase(s,'exiting-driver') end
    elseif c.phase=='exiting-driver' then
        if sample.auto.enabled or drive.foreign then c.error='The borrowed car is in use.'; return end
        if sample.playerMount and sample.playerMount.vehicle==c.car.id then phase(s,'waiting-for-player-exit'); return end
        if person then
            if not sample.actorValid then
                -- Removal/death owns the entity lifetime. Never resume walking
                -- or issue an unmount against a detached/dead native owner.
                if not sample.actorAttached or sample.actorDead then s.people[c.serial]=nil; person=nil
                else c.error='Companion ownership changed; waiting for the companion owner to resolve it.' end
            end
        end
        local skipSerial
        if not sample.actorValid then skipSerial=c.serial end
        local done=ops.leaveParty(s,player,hooks,skipSerial)
        if done then finish(s,c) end
    end
end
function M.interrupt(s,reason)
    local c=s.chauffeur
    if not c then return end
    -- Used only before a known loading transition, while references are live.
    -- The ordinary fleet serializes mount receipts, never a chauffeur intent.
    if c.operation then
        retire(s,c)
        -- The ordinary fast-travel receipt already knows how to retire an
        -- exact vehicle command. It never serializes this driving intention.
        c.car.command=c.operation; c.car.retired=true
    end
    c.reason=reason or 'Travel interrupted the trip.'; c.outcome='cancelled'
    s.lastChauffeur=M.snapshot(s); s.lastChauffeur.active=false; s.lastChauffeur.phase='cancelled'
    s.chauffeur=nil
end
function M.snapshot(s)
    local c=s.chauffeur
    if not c then return s.lastChauffeur and copy(s.lastChauffeur) or {active=false,phase='idle'} end
    return {active=true,phase=c.phase,generation=c.generation,offer=copy(c.offer),
        reason=c.reason,error=c.error,outcome=c.outcome,observed=copy(c.observed),
        backend='npc',vehicleCommand=copy(c.commandReceipt),stopObligation=c.stopObligation==true,
        destinationRevision=c.destinationRevision,driveRevision=c.driveRevision,retargets=c.retargets,
        passengerSeat=c.passengerSeat,partyReady=c.partyReady==true,
        driverSeatWaitUsed=(c.driverSeatWaitUsed or 0)+(c.driverSeatWaitAt and s.clock-c.driverSeatWaitAt or 0),
        driverSeatWaitRemaining=c.driverSeatWaitStarted and math.max(0,DRIVER_SEAT_GRACE
            -(c.driverSeatWaitUsed or 0)-(c.driverSeatWaitAt and s.clock-c.driverSeatWaitAt or 0)) or nil,
        stopAttempts=c.stopAttempts,brakeAttempts=c.brakeAttempts}
end
return M
