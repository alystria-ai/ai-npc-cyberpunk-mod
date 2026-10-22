-- A transaction inside companion-vehicles' movement/seat owner. There is no
-- update registration here and no independent NPC controller.
local M={}
local catalog=dofile('companion-vehicle-catalog.lua')
local RELEASE_TIMEOUT,BOARD_TIMEOUT,START_TIMEOUT=12,25,5
local STOP_TIMEOUT,PARTY_TIMEOUT,TRIP_TIMEOUT,STALL_TIMEOUT=15,75,1800,35
local STOPPING_HARD_TIMEOUT=60
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
local function preparation(phase)
    return phase=='exiting-passenger' or phase=='releasing' or phase=='boarding-driver' or phase=='waiting-for-driver-seat'
        or phase=='waiting-for-player' or phase=='waiting-for-party'
end
local function approaching(phase)
    return phase=='exiting-passenger' or phase=='releasing' or phase=='boarding-driver' or phase=='waiting-for-driver-seat'
end
-- Seated drive (V already sits in their own car). The seat swap is never forced: the game has no animated NPC seat switch, and
-- V's native switch needs a free front-right seat (docs/COMPANION_CHAUFFEUR.md, "Seated drive"). So a companion who is not
-- the driver yet steps out of the car, V leaves the driver seat if V has it, the companion takes the driver seat through the
-- ordinary driver boarding, and V sits in a passenger seat.
local function occupantOk(row,...)
    if not row then return false end
    if not row.occupant then return not row.reserved end
    for _,id in ipairs({...}) do if id and row.occupant==id then return true end end
    return false
end
local function busy(value,sample)
    return reject(value,'transport-busy','Wait for the current vehicle activity to finish.'),sample
end
local function offer(s,player,entry)
    -- A passenger-only companion (Alt Cunningham, a digital ghost) is never offered the wheel; no native read is needed to know.
    if not catalog.drives(entry) then return {available=false,code='does-not-drive',reason='This companion does not drive.'} end
    local sample,err=safe(s.chauffeurApi.sample,player,entry,nil,s.api)
    if not sample then return {available=false,code='world-unavailable',reason='Vehicle information is not ready.',error=err} end
    local value=publicOffer(sample)
    local pm,seated=sample.playerMount,nil
    if pm then
        -- V sits somewhere. Only V's own car (the exact car V sits in) qualifies, V as the driver or in a passenger seat.
        local ownCar=sample.car and sample.carValid and sample.car.id==pm.vehicle
        local passenger=pm.seat=='seat_front_right' or pm.seat=='seat_back_left' or pm.seat=='seat_back_right'
        if not ownCar or (pm.seat~='seat_front_left' and not passenger) then
            if pm.seat=='seat_front_left' then
                return reject(value,'player-driving','Step out of the driver seat before asking your companion to drive.'),sample
            end
            return reject(value,'player-seated','Step out before starting a new companion trip.'),sample
        end
        seated=pm.seat=='seat_front_left' and 'driver' or 'passenger'
        -- The fleet's own primary car is V's car; anything else is stale transport state.
        if s.primary and s.primary.id~=pm.vehicle then return busy(value,sample) end
    end
    if s.chauffeur then return busy(value,sample) end
    if seated then
        -- The ordinary party boarding may be running (V just sat down). The selected companion must be settled: seated in
        -- V's car, or not held by the fleet at all. Other people still boarding do not matter.
        if s.phase~='riding' and s.phase~='boarding' and s.phase~='on-foot' then return busy(value,sample) end
        local companion=s.people[entry.serial]
        if companion and companion.owned and (companion.phase~='riding' or companion.removing) then return busy(value,sample) end
    else
        if s.phase~='on-foot' then return busy(value,sample) end
        for _,person in pairs(s.people) do if person.owned then return busy(value,sample) end end
    end
    if not sample.actorValid or not sample.actor.id or type(sample.actor.key)~='string' or sample.actor.key=='' then
        return reject(value,'actor-unavailable','This managed companion is unavailable.'),sample
    end
    local dm=sample.driverMount
    if dm then
        -- Seated drive: the companion may sit in any seat of V's own car. Another vehicle's occupant is never touched.
        if not seated or not sample.car or dm.vehicle~=sample.car.id then
            return reject(value,'actor-seated','Your companion must step out before taking the driver seat.'),sample
        end
        if seated=='driver' and dm.seat=='seat_front_left' then
            return reject(value,'actor-unavailable','This managed companion is unavailable.'),sample
        end
    end
    if not sample.actorCalm or sample.playerCombat then return reject(value,'combat','Finish combat before asking for a ride.'),sample end
    if sample.auto.enabled then return reject(value,'autodrive-active','An AutoDrive journey is already active.'),sample end
    if sample.carSelectionError=='ambiguous' then
        return reject(value,'ambiguous-owned-car','More than one owned car is nearby. Select or summon the car you want to use.'),sample
    end
    if not sample.car or not sample.carValid then
        return reject(value,'no-owned-car','Stand near one of your owned cars, or summon one.'),sample
    end
    if not sample.info.ready or sample.info.invalid or sample.summonEnRoute then
        return reject(value,'car-arriving','Wait for your summoned car to arrive.'),sample
    end
    -- While V holds the wheel the car takes no AI commands; the NPC command is checked again at departure.
    if not sample.drive or not sample.drive.known or (seated~='driver' and not sample.drive.ready) then
        return reject(value,'driving-unavailable','Vehicle driving AI is not ready.'),sample
    end
    if sample.drive.foreign or sample.drive.busy then
        return reject(value,'transport-busy','Another vehicle activity has control.'),sample
    end
    if sample.info.speed>0.5 or sample.info.scene then return reject(value,'car-moving','Wait for your car to stop.'),sample end
    if not seated and (sample.info.playerGap or math.huge)>20 then return reject(value,'car-distant','Stand near your owned car.'),sample end
    if not sample.waypoint then return reject(value,'no-waypoint','Select a destination on the map first.'),sample end
    -- The driver seat: free, or V's own (V will step out), or this companion's own (V already sits as a passenger).
    if not occupantOk(seat(sample.info,'seat_front_left'),sample.playerId,sample.actor.id) then
        return reject(value,'driver-occupied','The driver seat is occupied or reserved.'),sample
    end
    if seated=='passenger' then value.passengerSeat=pm.seat
    else
        -- V's seat afterwards: the first passenger seat that is free or that this companion leaves.
        for _,name in ipairs(passengerSeats) do
            if occupantOk(seat(sample.info,name),sample.actor.id) then value.passengerSeat=name; break end
        end
    end
    if not value.passengerSeat then return reject(value,'no-passenger-seat','Your car has no free passenger seat for V.'),sample end
    value.seated=seated
    value.available=true
    return value,sample
end
function M.offer(s,player,entry) local value=offer(s,player,entry); return copy(value) end
local function matches(a,b)
    return type(a)=='table' and a.available==true and a.actor and a.car and a.waypoint
        and a.actor.serial==b.actor.serial and a.actor.id==b.actor.id and a.actor.key==b.actor.key
        and a.car.id==b.car.id and a.car.record==b.car.record and a.waypoint.id==b.waypoint.id
        and samePoint(a.waypoint.position,b.waypoint.position) and a.passengerSeat==b.passengerSeat
        and a.seated==b.seated
end
-- One probe.log line per stage of a seated drive ("Companion recovery vehicle-seated-drive"), never per frame: the live check
-- reads the stages and the seats in them.
local function trace(s,stage,fields)
    if type(s.report)=='function' then pcall(s.report,'seated-drive',fields) end
end
local function phase(s,value)
    local c=s.chauffeur; c.phase=value; c.phaseAt=s.clock
    if c.seated then trace(s,value,{stage=value,mode=c.seated,seat=c.passengerSeat,reason=c.reason}) end
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
    if value.seated and s.primary and s.primary.id==sample.car.id then
        -- The ordinary party boarding already holds V's car as its primary. Keep that table (the other people's seat records
        -- point at it) and refresh its identity fields from the borrowed-car sample.
        for key,item in pairs(sample.car) do s.primary[key]=item end
    else
        s.primary=sample.car -- borrowed: deliberately never added to the owned cars list
    end
    s.primary.summonBaseline={id=sample.summonedId,state=sample.summonState or (sample.summonEnRoute and 1 or 0)}
    local previous=s.people[entry.serial]
    local person={entry=entry,phase='releasing',attempts=0,owned=true,chauffeur=true,
        vehicle=s.primary,seat='seat_front_left'}
    local first='releasing'
    local sitting=sample.driverMount
    if value.seated then
        -- The walking owners were released when the fleet seated this companion; do not run that handoff twice.
        person.released=previous and previous.released or nil
        if sitting and sitting.vehicle==sample.car.id then
            person.mount=sitting
            if sitting.seat=='seat_front_left' then first='waiting-for-player'; person.phase='riding'
            else first='exiting-passenger' end
        end
    end
    s.people[entry.serial]=person
    s.chauffeur={phase=first,phaseAt=s.clock,startedAt=s.clock,offer=copy(value),entry=entry,player=player,
        car=s.primary,serial=entry.serial,waypoint=copy(sample.waypoint),passengerSeat=value.passengerSeat,
        playerId=sample.playerId,generation=s.generation,active=true,stopAttempts=0,brakeAttempts=0,
        destinationRevision=1,destinationAnchor=copy(sample.waypoint),driveRevision=0,retargets=0,backend='npc',
        seated=value.seated,seatedFrom=sitting and sitting.seat or nil}
    s.lastChauffeur=nil; s.phase='chauffeur'; s.error=nil
    if value.seated then
        trace(s,'queued',{stage='queued',mode=value.seated,vSeat=sample.playerMount and sample.playerMount.seat,
            companionSeat=sitting and sitting.seat or 'outside',first=first,seat=value.passengerSeat})
    end
    return true,nil,copy(value)
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
-- Our exact driving command is still live (or its retirement was never confirmed).
local function commandLive(c)
    if not c.operation or c.stopConfirmed then return false end
    return not (c.observed and terminal(c.observed.commandState))
end
-- The driver may be dismissed once the trip is only waiting for her exit and no drive command of ours is live: a failing exit
-- (V parked against a wall) must never keep her in the driver seat for the session. V is out of the car in that phase, so removing
-- the driver cannot switch V into her seat.
function M.canDismiss(s,serial)
    local c=s.chauffeur
    if c and c.serial==serial then
        if c.phase=='exiting-driver' and not commandLive(c) then return true end
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
    if not sample.carValid or not sample.car or sample.car.id~=c.car.id or sample.car.record~=c.car.record then return false,'The borrowed car is unavailable.' end
    if sample.info.scene then return false,'A scene has taken control of the car.' end
    local baseline=c.car.summonBaseline or {id=c.car.id,state=0}
    if sample.summonedId~=baseline.id or (sample.summonEnRoute and baseline.state~=1) then
        return false,'A new vehicle summon interrupted the trip.'
    end
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
    if c.phase=='stopping' and not c.yieldToPlayer and s.clock-c.phaseAt>STOPPING_HARD_TIMEOUT then
        -- The owned driving command could not be retired (its owner is gone, or the cancel never lands) or the car never reported
        -- stopped. Do not wait for ever: one last brake, drop the command, and let the driver leave. canDismiss now allows removal.
        if c.stopObligation then safe(s.chauffeurApi.brake,c.car,c.operation) end
        c.operation,c.commandReceipt,c.stopConfirmed=nil,nil,true
        c.error='The driving command could not be retired in time. The companion leaves the car anyway.'
        phase(s,'exiting-driver')
    end
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
        if c.phase=='exiting-passenger' then
            -- Seated drive: the companion is still stepping out of its seat. The 45 s allowance for V to leave the
            -- driver seat starts only once the companion is out, so the exit animation does not eat into it.
            c.error='Step out of the driver seat so your companion can get in.'
        else
            if not c.driverSeatWaitStarted then
                c.driverSeatWaitStarted=s.clock
                c.driverSeatWaitUsed=0
            end
            if c.phase~='waiting-for-driver-seat' then
                c.driverSeatWaitAt=s.clock
                phase(s,'waiting-for-driver-seat')
            end
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
    elseif c.phase=='exiting-passenger' then
        -- Seated drive: the companion sits in a passenger seat of V's car. It steps out first (an animated exit from this
        -- exact car); the ordinary driver boarding takes over from there.
        if ops.exitSeat(s,person,hooks) then
            if not takingOver then c.error=nil end
            phase(s,'boarding-driver')
        elseif age>BOARD_TIMEOUT then stop(s,'The companion could not step out of the passenger seat.','failed') end
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
            if c.seated and not c.operation and not driverSeated(c,sample) then
                -- Seated drive that ended before the companion reached the driver seat (V changed their mind, combat, a
                -- timeout): nothing was driven, so the ordinary party transport simply takes everyone back. The companion
                -- keeps its seat or walks back to the car; V is never moved.
                if ops.yieldToPlayer(s,player,hooks) then
                    trace(s,'ended',{stage='yielded',mode=c.seated,reason=c.reason})
                    s.lastChauffeur=M.snapshot(s); s.lastChauffeur.active=false; s.lastChauffeur.phase=c.outcome or 'cancelled'
                    s.chauffeur=nil
                else c.error='Waiting for the companion to settle.' end
                return
            end
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
        dismissible=M.canDismiss(s,c.serial)==true,
        destinationRevision=c.destinationRevision,driveRevision=c.driveRevision,retargets=c.retargets,
        passengerSeat=c.passengerSeat,seated=c.seated,partyReady=c.partyReady==true,
        driverSeatWaitUsed=(c.driverSeatWaitUsed or 0)+(c.driverSeatWaitAt and s.clock-c.driverSeatWaitAt or 0),
        driverSeatWaitRemaining=c.driverSeatWaitStarted and math.max(0,DRIVER_SEAT_GRACE
            -(c.driverSeatWaitUsed or 0)-(c.driverSeatWaitAt and s.clock-c.driverSeatWaitAt or 0)) or nil,
        stopAttempts=c.stopAttempts,brakeAttempts=c.brakeAttempts}
end
return M
