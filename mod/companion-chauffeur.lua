-- A transaction inside companion-vehicles' movement/seat owner. There is no
-- update registration here and no independent NPC controller.
local M={}
local RELEASE_TIMEOUT,BOARD_TIMEOUT,START_TIMEOUT=12,25,5
local STOP_TIMEOUT,PARTY_TIMEOUT,TRIP_TIMEOUT,STALL_TIMEOUT=15,75,1800,35
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
        car=s.primary,serial=entry.serial,waypoint=copy(value.waypoint),passengerSeat=value.passengerSeat,
        generation=s.generation,active=true,stopAttempts=0,brakeAttempts=0}
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
    stop(s,reason or 'Trip cancelled.','cancelled'); return true
end
function M.canDismiss(s,serial)
    if s.chauffeur and s.chauffeur.serial==serial then
        return false,'Stop the trip and step out before dismissing your driver.'
    end
    return true
end
function M.prepareShutdown(s,reason)
    local c=s.chauffeur
    if not c then return true end
    stop(s,reason or 'The mod is stopping. Step out before dismissing your driver.','cancelled')
    if (c.nativeOwned or c.enablePending) and not c.shutdownNativeAttempt then
        c.shutdownNativeAttempt=true
        c.brakeAttempts=c.brakeAttempts+1; c.brakeAt=s.clock+4
        safe(s.chauffeurApi.brake,c.car)
        c.stopAttempts=c.stopAttempts+1; c.stopAt=s.clock+1
        local done=safe(s.chauffeurApi.disable,c.player,c.car,c.enablePending==true,s.api)
        if done then c.disableSent=true; c.disableAt=s.clock end
    end
    -- Reload cannot wait for player exit. Return a plain cleanup receipt and
    -- retain the live owner; the caller must not delete this driver or pretend
    -- that a new Lua instance can automatically recover its native commands.
    return false,'The driver remains protected until V exits and cleanup finishes.',
        {actor=copy(c.offer.actor),car=copy(c.offer.car),passengerSeat=c.passengerSeat,
            phase=c.phase,nativeStopRequested=c.disableSent==true}
end
function M.autodriveToggled(s,enabled)
    local c=s.chauffeur
    if c and not enabled and (c.nativeOwned or c.enablePending) then
        c.nativeEndObserved=true; c.nativeOwned=false; c.enablePending=false
    end
end
function M.arrived(s,vehicleId)
    local c=s.chauffeur
    if c and c.car.id==vehicleId and (c.nativeOwned or c.enablePending) then c.arrivalObserved=true end
end
local function binding(c,sample,requirePassenger)
    if not sample.actorValid or sample.actor.id~=c.offer.actor.id or sample.actor.key~=c.offer.actor.key then
        return false,'The companion binding changed.'
    end
    if not sample.actorCalm or sample.playerCombat then return false,'The trip stopped for combat.' end
    if not sample.carValid or not sample.car or sample.car.id~=c.car.id then return false,'The borrowed car is unavailable.' end
    if sample.info.scene then return false,'A scene has taken control of the car.' end
    if sample.summonedId~=c.car.id then return false,'A different car was summoned.' end
    if not sample.waypoint or sample.waypoint.id~=c.waypoint.id
        or not samePoint(sample.waypoint.position,c.waypoint.position) then return false,'The map destination changed.' end
    local pm=sample.playerMount
    if pm and (pm.vehicle~=c.car.id or pm.seat~=c.passengerSeat) then return false,'V changed seats or vehicles.' end
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
    local sample,err=safe(s.chauffeurApi.sample,player,c.entry,c.car,s.api)
    if not sample then
        stop(s,'Vehicle information became unavailable.','failed')
        -- Waypoint/UI reads can fail independently of the exact native vehicle
        -- binding. The stop adapter rechecks that binding itself, so one bad
        -- observation must not leave an owned car driving indefinitely.
        if (c.nativeOwned or c.enablePending) and c.stopAttempts<3 and s.clock>=(c.stopAt or 0) then
            c.stopAttempts=c.stopAttempts+1; c.stopAt=s.clock+1
            local done=safe(s.chauffeurApi.disable,player,c.car,c.enablePending==true,s.api)
            if done then
                c.disableSent=true; c.disableAt=s.clock
                if c.brakeAttempts<3 then c.brakeAttempts=c.brakeAttempts+1; safe(s.chauffeurApi.brake,c.car) end
            end
        end
        c.error=err or 'Waiting for current vehicle information.'; return
    end
    c.observed={enabled=sample.auto.enabled,vehicle=sample.auto.vehicleId,remaining=sample.auto.remaining,
        speed=sample.info.speed,playerSeat=sample.playerMount and sample.playerMount.seat,
        driverSeat=sample.driverMount and sample.driverMount.seat}
    if sample.playerMount and sample.playerMount.vehicle==c.car.id then c.playerEverMounted=true end
    if sample.car and sample.car.id==c.car.id then
        c.car.entity=sample.car.entity; c.car.info=sample.info
    end
    if person then person.mount=sample.driverMount end
    if (c.phase=='driving' and not sample.auto.enabled)
        or (c.nativeEndObserved and (c.phase=='driving' or c.phase=='starting')) then
        -- OnAutodriveToggled's off edge also prevents claiming an off/on user
        -- takeover between samples. Only the native arrival event qualifies
        -- completion; a vanished waypoint alone can be a manual cancellation.
        c.nativeOwned=false
        local arrived=c.arrivalObserved
        stop(s,arrived and 'Destination reached. Step out when ready.' or 'AutoDrive ended. Step out when ready.',
            arrived and 'completed' or 'stopped')
    elseif c.phase~='stopping' and c.phase~='waiting-for-player-exit' and c.phase~='exiting-driver' then
        local ok,reason=binding(c,sample,c.phase=='waiting-for-party' or c.phase=='starting' or c.phase=='driving')
        if not ok then stop(s,reason,'cancelled') end
        if c.phase~='releasing' and c.phase~='boarding-driver' and not driverSeated(c,sample) then
            stop(s,'The companion left the driver seat.','cancelled')
        end
    end
    local age=s.clock-c.phaseAt
    if c.phase=='releasing' then
        if ops.prepare(s,person,hooks) then phase(s,'boarding-driver')
        elseif age>RELEASE_TIMEOUT then stop(s,'Walking commands did not release in time.','failed') end
    elseif c.phase=='boarding-driver' then
        ops.board(s,person,hooks,1)
        if person.phase=='riding' and driverSeated(c,sample) then phase(s,'boarding-player')
        elseif age>BOARD_TIMEOUT then stop(s,'The companion could not finish entering the driver seat.','failed') end
    elseif c.phase=='boarding-player' then
        local pm=sample.playerMount
        if pm and pm.vehicle==c.car.id and pm.seat==c.passengerSeat and sample.playerPassenger then
            phase(s,'waiting-for-party')
        elseif not c.partyReady and not c.playerMountSent then
            -- With V still on foot, native follower auto-boarding cannot race
            -- our reserved front passenger slot while the party is entering.
            if age>PARTY_TIMEOUT then stop(s,'The party could not finish boarding. The trip was cancelled.','failed') end
        elseif not pm and not c.playerMountSent then
            c.playerMountSent=true -- even a throwing native submission can have side effects
            c.playerMountAt=s.clock
            local done,why=safe(s.chauffeurApi.mountPlayer,player,c.car,c.passengerSeat,s.api,c.entry)
            if done==false then c.playerMountSent=false end
            if not done then stop(s,why or 'Passenger boarding could not start.','failed') end
        elseif s.clock-(c.playerMountAt or c.phaseAt)>BOARD_TIMEOUT then
            stop(s,'V did not finish entering the reserved passenger seat.','failed')
        end
    elseif c.phase=='waiting-for-party' then
        if c.partyReady then phase(s,'starting')
        elseif age>PARTY_TIMEOUT then stop(s,'The party could not finish boarding. The trip was cancelled.','failed') end
    elseif c.phase=='starting' then
        if sample.auto.enabled then
            if c.enablePending and sample.auto.vehicleId==c.car.id and not sample.auto.delamain
                and not sample.auto.freeRoam and sample.auto.destinationId==c.waypoint.id then
                c.enablePending=false; c.nativeOwned=true; c.progressAt=s.clock
                c.lastRemaining=sample.auto.remaining; phase(s,'driving')
            else stop(s,'Another AutoDrive activity took control.','cancelled') end
        elseif not c.enableSent then
            if not sample.auto.available or not (sample.auto.playerTracked or sample.auto.questTracked)
                or sample.auto.destinationId~=c.waypoint.id then
                stop(s,'AutoDrive cannot use this road or destination. Move the car onto a valid road and try again.','failed')
            else
                c.enableSent=true; c.enablePending=true
                local done,why=safe(s.chauffeurApi.enable,player,c.entry,c.car,c.waypoint,c.passengerSeat,s.api)
                if done==false then c.enablePending=false end
                if not done then stop(s,why or 'AutoDrive did not accept departure.','failed') end
            end
        elseif age>START_TIMEOUT then stop(s,'AutoDrive did not start in time.','failed') end
    elseif c.phase=='driving' then
        if sample.auto.vehicleId~=c.car.id or sample.auto.delamain then
            c.nativeOwned=false; stop(s,'Another AutoDrive activity took control.','cancelled')
        elseif not sample.auto.available or sample.auto.freeRoam or sample.auto.destinationId~=c.waypoint.id then
            stop(s,'AutoDrive is no longer available for this trip.','cancelled')
        else
            local remaining=sample.auto.remaining
            if type(remaining)=='number' and remaining>=0 then
                -- Native distance is a local traffic-slot path, which can
                -- start at zero and reset upward when its next segment loads.
                if not c.lastRemaining or remaining<c.lastRemaining-2 then c.progressAt=s.clock end
                c.lastRemaining=remaining
            end
            if sample.info.ready and sample.info.speed>0.3 then c.progressAt=s.clock end
            if s.clock-(c.progressAt or s.clock)>STALL_TIMEOUT then stop(s,'The route is blocked. Step out or try a new trip.','failed')
            elseif s.clock-c.startedAt>TRIP_TIMEOUT then stop(s,'The trip exceeded its time limit.','failed') end
        end
    end
    if c.phase=='stopping' then
        local ownsNative=c.nativeOwned or c.enablePending
        local other=sample.auto.enabled and (not ownsNative or sample.auto.vehicleId~=c.car.id or sample.auto.delamain)
        if other then c.error='Waiting for the other AutoDrive activity to finish.'; return end
        local pm=sample.playerMount
        local takeover=pm and pm.vehicle==c.car.id and pm.seat=='seat_front_left'
        if not takeover and sample.info.ready and (sample.info.speed>0.5 or ownsNative)
            and c.brakeAttempts<3 and s.clock>=(c.brakeAt or 0) then
            c.brakeAttempts=c.brakeAttempts+1; c.brakeAt=s.clock+4
            local done,why=safe(s.chauffeurApi.brake,c.car); if not done then c.error=why end
        end
        if ownsNative and not (c.disableSent and not sample.auto.enabled)
            and c.stopAttempts<3 and s.clock>=(c.stopAt or 0) then
            c.stopAttempts=c.stopAttempts+1; c.stopAt=s.clock+1
            local done,why=safe(s.chauffeurApi.disable,player,c.car,c.enablePending==true,s.api)
            if done then c.disableSent=true; c.disableAt=s.clock else c.error=why end
        end
        -- Observe the state on a later update after the disable was queued.
        if not sample.auto.enabled and (not ownsNative or (c.disableSent and s.clock>c.disableAt)) then
            c.nativeOwned=false; c.enablePending=false
            if sample.info.ready and sample.info.speed<=0.5 and not sample.info.scene then
                c.error=nil
                if pm and pm.vehicle==c.car.id then phase(s,'waiting-for-player-exit')
                elseif c.playerMountSent and not c.playerEverMounted then
                    -- Mount() exposes no cancellation or completion receipt.
                    -- Keep the driver seated if a submitted player mount has
                    -- never been observed; a late mount must not meet an empty
                    -- driver seat. Entering and exiting the car resolves it.
                    c.error='Passenger boarding is unresolved. Enter the car and step out before your companion leaves.'
                else phase(s,'exiting-driver') end
            elseif not sample.car and not sample.driverMount then phase(s,'exiting-driver') end
        end
        if s.clock-c.phaseAt>STOP_TIMEOUT then c.error=c.error or 'Waiting for confirmed AutoDrive shutdown and a stopped car.' end
    elseif c.phase=='waiting-for-player-exit' then
        if sample.auto.enabled then c.error='Finish the active AutoDrive journey before your companion gets out.'; return end
        if not sample.playerMount or sample.playerMount.vehicle~=c.car.id then phase(s,'exiting-driver') end
    elseif c.phase=='exiting-driver' then
        if sample.auto.enabled and sample.auto.vehicleId==c.car.id then c.error='The borrowed car is in use.'; return end
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
    if c.nativeOwned or c.enablePending then
        safe(s.chauffeurApi.brake,c.car)
        safe(s.chauffeurApi.disable,c.player,c.car,c.enablePending==true,s.api)
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
        enablePending=c.enablePending==true,nativeOwned=c.nativeOwned==true,
        playerMountSent=c.playerMountSent==true,partyReady=c.partyReady==true,
        stopAttempts=c.stopAttempts,brakeAttempts=c.brakeAttempts}
end
return M
