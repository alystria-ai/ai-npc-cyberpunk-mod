-- Party transport owns movement only between the release and resume handoffs.
-- Policy is native-free and runs against the same adapter contract in tests.
local catalog=dofile('companion-vehicle-catalog.lua')
local M={}
local stopChauffeurConvoy
local MAX_ATTEMPTS=3
local BOARD_TIMEOUT,EXIT_TIMEOUT,ATTACH_TIMEOUT=20,12,12
local function terminal(state)
    return state=='Success' or state=='Failure' or state=='Cancelled' or state=='Interrupted' or state=='Detached'
end
local function safe(fn,...)
    local ok,a,b,c=pcall(fn,...)
    if not ok then return nil,tostring(a) end
    return a,b,c
end
local function emit(s,event,person)
    if #s.events>=32 then table.remove(s.events,1) end
    s.events[#s.events+1]={at=s.clock,event=event,serial=person and person.entry.serial,generation=s.generation}
end
function M.new(api,chauffeurApi)
    return {api=api or dofile('companion-vehicle-native.lua'),clock=0,phase='on-foot',
        chauffeurApi=chauffeurApi,people={},cars={},events={},generation=0,spawnAttempts=0,spawnFailures=0,spawnAt=0}
end
local function chauffeur(s)
    if not s.chauffeurModule then s.chauffeurModule=dofile('companion-chauffeur.lua') end
    if not s.chauffeurApi then s.chauffeurApi=dofile('companion-chauffeur-native.lua') end
    return s.chauffeurModule
end
function M.chauffeurOffer(s,player,entry) return chauffeur(s).offer(s,player,entry) end
function M.queueChauffeur(s,player,entry,expectedOffer)
    return chauffeur(s).queue(s,player,entry,expectedOffer)
end
function M.cancelChauffeur(s,reason)
    if not s.chauffeur then return false,'There is no companion trip to cancel.' end
    return chauffeur(s).cancel(s,reason)
end
function M.chauffeurSnapshot(s)
    return s.chauffeurModule and s.chauffeurModule.snapshot(s) or {active=false,phase='idle'}
end
function M.chauffeurAutodriveToggled(s,enabled)
    if s.chauffeur then chauffeur(s).autodriveToggled(s,enabled) end
end
function M.chauffeurArrived(s,vehicleId)
    if s.chauffeur then chauffeur(s).arrived(s,vehicleId) end
end
function M.canDismissChauffeurDriver(s,serial)
    if not s.chauffeur then return true end
    return chauffeur(s).canDismiss(s,serial)
end
function M.prepareChauffeurShutdown(s,reason)
    if not s.chauffeur then return true end
    local done,why,receipt=chauffeur(s).prepareShutdown(s,reason)
    stopChauffeurConvoy(s)
    return done,why,receipt
end
local function releaseCommand(s,holder)
    if not holder.command then return true end
    local done,err=safe(s.api.cancel,holder.command)
    if done then holder.command=nil; return true end
    holder.error=err or 'Waiting for the owned vehicle command to stop.'
    return false
end
local function acquired(s,entries)
    for _,entry in ipairs(entries) do
        local person=s.people[entry.serial]
        if not person then
            person={entry=entry,phase='releasing',attempts=0,owned=true}
            s.people[entry.serial]=person
        else person.entry=entry end
    end
end
local function ordered(s)
    local list={}
    for _,person in pairs(s.people) do list[#list+1]=person end
    table.sort(list,function(a,b) return a.entry.serial<b.entry.serial end)
    return list
end
local function seats(vehicle)
    local list={}
    for _,seat in ipairs(vehicle.info and vehicle.info.seats or {}) do list[#list+1]=seat end
    local rank={seat_front_left=0,seat_front_right=1,seat_back_left=2,seat_back_right=3}
    table.sort(list,function(a,b)
        local ar,br=rank[a.name] or 10,rank[b.name] or 10
        return ar==br and a.name<b.name or ar<br
    end)
    return list
end
local function reserved(s,vehicle,seat,except)
    if s.chauffeur and s.chauffeur.car.id==vehicle.id and s.chauffeur.passengerSeat==seat then return true end
    for _,person in pairs(s.people) do
        if person~=except and person.vehicle==vehicle and person.seat==seat then return true end
    end
    return false
end
local function available(s,vehicle,seat,person)
    local ownId=person and tostring(person.entry.entityID.hash)
    return (not seat.occupant or seat.occupant==ownId)
        and (not seat.reserved or seat.occupant==ownId)
        and not reserved(s,vehicle,seat.name,person)
end
local function assign(s,person,vehicle,seat)
    person.vehicle,person.seat=vehicle,seat
    person.phase='waiting-to-board'
    person.attempts,person.retryAt,person.error=0,nil,nil
    emit(s,'seat-reserved',person)
end
local function pending(s)
    local list={}
    for _,person in ipairs(ordered(s)) do
        if person.owned and not person.vehicle then list[#list+1]=person end
    end
    return list
end
local function fill(s,vehicle)
    if not vehicle.info or not vehicle.info.ready then return end
    for _,seat in ipairs(seats(vehicle)) do
        if seat.name~='seat_front_left' then
            local queue=pending(s)
            if queue[1] and available(s,vehicle,seat,queue[1]) then assign(s,queue[1],vehicle,seat.name) end
        end
    end
end
local function refresh(s)
    local all={}
    if s.primary then all[#all+1]=s.primary end
    for _,car in ipairs(s.cars) do if car~=s.primary then all[#all+1]=car end end
    for _,car in ipairs(all) do
        if car.deleteRequested then
            -- An accepted despawn may have already retired the component.
            -- Its system receipt is the only remaining cleanup authority.
            car.info={ready=false,deleting=true}
        else
            local info,err=safe(s.api.inspect,car)
            car.info=info or {ready=false,error=err}
        end
        if car.pendingCommand and car.info.ready then
            local command,reason=safe(s.api.retiredCommand,car.pendingCommand,car.entity,true)
            if command then car.command=command; car.pendingCommand=nil
            else car.error=reason end
        end
    end
end
local function startExit(s,reason)
    if s.phase=='recovering' or (s.phase=='exiting' and reason~='fast-travel') then return end
    s.phase=reason=='fast-travel' and 'recovering' or 'exiting'
    s.exitReason=reason
    s.recoveryPositions={}
    for _,person in pairs(s.people) do
        person.phase='leaving'; person.attempts=0; person.retryAt=nil
    end
    emit(s,reason)
end
local function begin(s,primary,entries)
    s.generation=s.generation+1
    s.primary=primary
    -- V may enter a car the mod created earlier. Keep its ownership receipt,
    -- but it becomes the borrowed primary and receives no autonomous command.
    for _,car in ipairs(s.cars) do if car.id==primary.id then s.primary=car; break end end
    s.phase='boarding'; s.spawnAttempts=0; s.spawnFailures=0; s.spawnAt=0; s.error=nil
    acquired(s,entries)
    emit(s,'journey-start')
end
local function allocate(s,player)
    if not s.primary.info or not s.primary.info.ready then
        s.error='Waiting for the passenger capacity of your vehicle.'; return
    end
    s.error=nil
    -- A native follower can have boarded between two samples. Actual mounting
    -- takes precedence over an uncommitted local passenger-seat reservation.
    for _,person in ipairs(pending(s)) do
        local mount=safe(s.api.mounting,person.entry)
        if mount and mount.vehicle==s.primary.id and mount.seat~='seat_front_left'
            and not reserved(s,s.primary,mount.seat,person) then
            assign(s,person,s.primary,mount.seat)
        end
    end
    fill(s,s.primary)
    for _,car in ipairs(s.cars) do
        if car~=s.primary and not car.retired then
            if car.info and car.info.ready then
                local driver=s.people[car.driver]
                if driver and not driver.vehicle then
                    for _,seat in ipairs(seats(car)) do
                        if seat.name=='seat_front_left' and available(s,car,seat,driver) then
                            assign(s,driver,car,seat.name); break
                        end
                    end
                end
                if not driver or driver.vehicle~=car then
                    car.retired=true; car.error='The new car has no available driver seat.'
                    s.spawnFailures=s.spawnFailures+1
                else fill(s,car) end
            elseif s.clock-car.createdAt>ATTACH_TIMEOUT then
                car.retired=true; car.error='Party car did not attach in time.'
                s.spawnFailures=s.spawnFailures+1
            else return end -- only one uninspected car can be created at once
        end
    end
    local queue=pending(s)
    if #queue==0 or s.clock<s.spawnAt or s.spawnFailures>=MAX_ATTEMPTS then return end
    if #s.cars>=8 then s.error='Party vehicle limit reached.'; return end
    local choice,driver=catalog.choose(queue)
    if s.spawnAttempts>0 then choice=catalog.fallback end
    local attempts,at=s.spawnAttempts,s.spawnAt
    s.spawnAttempts=s.spawnAttempts+1; s.spawnAt=s.clock+3
    local car,err,deferred=safe(s.api.spawn,choice,player,s.primary,#s.cars+1)
    if deferred then s.spawnAttempts,s.spawnAt=attempts,at; return end
    if not car then s.spawnFailures=s.spawnFailures+1; s.error=err or 'Could not create the next party car.'; return end
    car.owned=true; car.createdAt=s.clock; car.driver=driver.entry.serial; car.ordinal=#s.cars+1
    car.followAttempts=0
    s.cars[#s.cars+1]=car
    s.spawnAttempts=0
    emit(s,'overflow-car-created',driver)
end
local function prepare(s,person,hooks)
    if person.released then return true end
    local done,err=safe(hooks.release,person.entry)
    if done then person.released=true; return true end
    person.error=err or 'Waiting for walking and equipment commands to release.'
    return false
end
local function finish(s,person,hooks)
    if not person.owned then return end
    local done,err=safe(hooks.resumed,person.entry)
    -- A callback returning nil is an ordinary successful Lua callback.
    if err then person.error=err; return end
    person.owned=false; person.phase='on-foot'; person.vehicle=nil; person.seat=nil
    emit(s,'walking-resumed',person)
end
local function observeMount(s,person)
    local mount,err=safe(s.api.mounting,person.entry)
    if err then person.error=err; return nil,false end
    person.mount=mount
    return mount,true
end
local function board(s,person,hooks,budget)
    if not prepare(s,person,hooks) then return budget end
    local mount,known=observeMount(s,person)
    if not known then return budget end
    if not person.vehicle then person.phase='waiting-for-seat'; return budget end
    local car=person.vehicle
    if not car.info or not car.info.ready then person.error='Waiting for vehicle attachment.'; return budget end
    local matching=mount and mount.vehicle==car.id and mount.seat==person.seat
    -- Native follower AI can finish a different free passenger seat first.
    -- Adopt only a real seat in this same car, never a driver or a foreign car.
    if not person.chauffeur and mount and mount.vehicle==car.id and not matching and mount.seat~='seat_front_left'
        and not reserved(s,car,mount.seat,person) then
        person.seat=mount.seat; matching=true
    end
    if matching then
        if person.command then
            local status,err=safe(s.api.commandState,person.command)
            if not terminal(status) then person.error=err; return budget end
            person.command=nil
        end
        person.phase='riding'; person.error=nil
        return budget
    end
    if mount then person.error='Companion is mounted in another seat or vehicle.'; return budget end
    if person.command then
        local status,err=safe(s.api.commandState,person.command)
        if terminal(status) or s.clock-person.commandAt>BOARD_TIMEOUT then
            if not releaseCommand(s,person) then return budget end
            person.retryAt=s.clock+3; person.phase='boarding-retry'
            person.error=err or 'Boarding did not reach the reserved seat.'
        else return budget end
    end
    if person.attempts>=MAX_ATTEMPTS then person.phase='boarding-failed'; return budget end
    if s.clock<(person.retryAt or 0) or budget<=0 or car.info.speed>0.8 or car.info.scene then return budget end
    if s.api.canBoard then
        local calm,err=safe(s.api.canBoard,person.entry)
        if not calm then person.error=err or 'Waiting for combat to finish before boarding.'; return budget end
    end
    local found
    for _,seat in ipairs(car.info.seats) do if seat.name==person.seat then found=seat; break end end
    if not found or not available(s,car,found,person) then
        person.vehicle,person.seat=nil,nil; person.phase='waiting-for-seat'
        person.error='Reserved seat became unavailable.'
        return budget
    end
    person.attempts=person.attempts+1
    person.commandAt=s.clock
    local command,err=safe(s.api.mount,person.entry,car,person.seat,false)
    person.command=command; person.phase='boarding'; person.error=err
    if not command then person.retryAt=s.clock+3 end
    emit(s,'mount-requested',person)
    return budget-1
end
local function follow(s,car,player,budget)
    if car==s.primary or car.retired or not car.info or not car.info.ready or car.info.playerMounted then return budget end
    local driver=s.people[car.driver]
    local ready=driver and driver.vehicle==car and driver.phase=='riding'
    for _,person in pairs(s.people) do if person.vehicle==car and person.phase~='riding' then ready=false end end
    if not ready then
        if car.command and releaseCommand(s,car) then safe(s.api.brake,car) end
        return budget
    end
    if car.command then
        if car.info.speed<0.3 and (car.info.playerGap or 0)>45 then
            car.stallSince=car.stallSince or s.clock
            if s.clock-car.stallSince>20 then
                if releaseCommand(s,car) then
                    safe(s.api.brake,car); car.retryAt=s.clock+3; car.stallSince=nil
                    car.error='The convoy car is blocked; native route retries are bounded.'
                end
                return budget
            end
        else car.stallSince=nil end
        local status,err=safe(s.api.commandState,car.command)
        if not terminal(status) then car.error=err; return budget end
        car.command=nil; car.retryAt=s.clock+3
        car.error='Native convoy command ended.'
    end
    if budget<=0 or car.followAttempts>=MAX_ATTEMPTS or s.clock<(car.retryAt or 0) then return budget end
    car.followAttempts=car.followAttempts+1
    car.stallSince=nil
    local command,err=safe(s.api.follow,car,player,car.ordinal)
    car.command=command; car.error=err
    if not command then car.retryAt=s.clock+3 end
    emit(s,'convoy-requested',driver)
    return budget-1
end
local function cleanup(s)
    for i=#s.cars,1,-1 do
        local car=s.cars[i]
        local assigned=false
        for _,person in pairs(s.people) do if person.owned and person.vehicle==car then assigned=true; break end end
        if not car.retired and car.driver and s.people[car.driver] and s.people[car.driver].owned then assigned=true end
        if not assigned and not car.command and not car.pendingCommand and not (car.info and car.info.playerMounted)
            and s.clock>=(car.deleteAt or 0) and (car.deleteRequested or (car.deleteAttempts or 0)<MAX_ATTEMPTS) then
            if not car.deleteRequested then car.deleteAttempts=(car.deleteAttempts or 0)+1 end
            car.deleteAt=s.clock+5
            local done,err=safe(s.api.destroy,car)
            if done then table.remove(s.cars,i); emit(s,'empty-car-deleted')
            else car.error=err or 'Could not remove the empty party car.' end
        end
    end
end
local function leave(s,person,player,hooks,budget,recoveryPositions)
    if not person.owned then return budget end
    if person.removing then releaseCommand(s,person); return budget end
    if not prepare(s,person,hooks) then return budget end
    local mount,known=observeMount(s,person)
    if not known then return budget end
    if person.command then
        local status=safe(s.api.commandState,person.command)
        if person.phase=='unmounting' and not terminal(status) and s.clock-person.commandAt<=EXIT_TIMEOUT then return budget end
        if not releaseCommand(s,person) then return budget end
        person.retryAt=s.clock+2
    end
    if not mount then
        if s.phase=='recovering' then
            if s.clock<(person.recoverAt or 0) or (person.recoverAttempts or 0)>=MAX_ATTEMPTS then return budget end
            local attempts,at=person.recoverAttempts,person.recoverAt
            person.recoverAttempts=(person.recoverAttempts or 0)+1; person.recoverAt=s.clock+2
            local done,err,deferred=safe(s.api.recover,person.entry,player,recoveryPositions)
            if deferred then person.recoverAttempts,person.recoverAt=attempts,at; return budget end
            if not done then person.phase='recovery-failed'; person.error=err; return budget end
        end
        finish(s,person,hooks); return budget
    end
    local car=person.vehicle
    if not car or mount.vehicle~=car.id then
        person.error='Companion entered another vehicle; its occupant is left unchanged.'
        -- A foreign mount is not an on-foot handoff. Wait for its native
        -- dismount instead of issuing walking into somebody else's vehicle.
        person.phase='waiting-for-native-dismount'; return budget
    end
    if budget<=0 or not car.info or not car.info.ready or car.info.speed>0.5 or car.info.scene
        or s.clock<(person.retryAt or 0) then return budget end
    if car.command or car.pendingCommand then return budget end
    if person.attempts>=MAX_ATTEMPTS then person.phase='exit-failed'; return budget end
    person.attempts=person.attempts+1; person.commandAt=s.clock
    local command,err=safe(s.api.mount,person.entry,car,mount.seat,true)
    person.command=command; person.phase='unmounting'; person.error=err
    if not command then person.retryAt=s.clock+2 end
    emit(s,'unmount-requested',person)
    return budget-1
end
stopChauffeurConvoy=function(s)
    for _,car in ipairs(s.cars) do
        if not car.deleteRequested and not car.pendingCommand and releaseCommand(s,car)
            and not car.braked and (car.brakeAttempts or 0)<MAX_ATTEMPTS and s.clock>=(car.brakeAt or 0) then
            car.brakeAttempts=(car.brakeAttempts or 0)+1; car.brakeAt=s.clock+2
            local done,err=safe(s.api.brake,car); car.braked=done==true
            if err then car.error=err end
        end
    end
end
local function leaveChauffeurParty(s,player,hooks,skipSerial)
    local budget=2
    stopChauffeurConvoy(s)
    for _,person in ipairs(ordered(s)) do
        if person.entry.serial~=skipSerial then budget=leave(s,person,player,hooks,budget,{}) end
    end
    for _,person in pairs(s.people) do if person.owned then return false end end
    return true
end
function M.update(s,player,entries,dt,hooks)
    s.clock=s.clock+math.max(0,tonumber(dt) or 0)
    hooks=hooks or {}
    if type(hooks.release)~='function' or type(hooks.resumed)~='function' then
        s.error='Vehicle movement handoff callbacks are required.'; return
    end
    if s.chauffeur and s.fastTravelPending then
        chauffeur(s).interrupt(s,'Fast travel cancelled the companion trip.')
    elseif s.chauffeur then
        refresh(s)
        local trip=s.chauffeur
        local closing=trip.phase=='stopping' or trip.phase=='waiting-for-player-exit' or trip.phase=='exiting-driver'
        if not closing then
            acquired(s,entries)
            allocate(s,player)
            local budget=1
            for _,person in ipairs(ordered(s)) do
                if person.entry.serial~=trip.serial then budget=board(s,person,hooks,budget) end
            end
            trip.partyReady=true
            for _,person in pairs(s.people) do
                if person.owned and (person.phase~='riding' or person.removing) then trip.partyReady=false end
            end
        end
        chauffeur(s).update(s,player,entries,hooks,{prepare=prepare,board=board,leaveParty=leaveChauffeurParty})
        if s.chauffeur then
            if s.chauffeur.phase=='driving' or (s.chauffeur.phase=='starting' and s.chauffeur.partyReady) then
                local budget=2
                for _,car in ipairs(s.cars) do budget=follow(s,car,player,budget) end
            elseif s.chauffeur.phase=='stopping' or s.chauffeur.phase=='waiting-for-player-exit'
                or s.chauffeur.phase=='exiting-driver' then stopChauffeurConvoy(s) end
        end
        cleanup(s)
        return
    end
    local primary,err=safe(s.api.player,player)
    if err then s.error=err; return end
    if s.fastTravelPending then
        acquired(s,entries); startExit(s,'fast-travel'); s.fastTravelPending=nil
    elseif s.phase=='on-foot' and primary and #entries>0 then begin(s,primary,entries)
    elseif s.phase=='boarding' or s.phase=='riding' then
        acquired(s,entries)
        if s.replan or not primary or primary.id~=s.primary.id then startExit(s,'vehicle-change'); s.replan=nil end
    end
    refresh(s)
    if s.phase=='boarding' or s.phase=='riding' then
        for _,car in ipairs(s.cars) do
            if car.info and car.info.invalid then startExit(s,'vehicle-damaged'); break end
        end
    end
    local budget=2
    if s.phase=='boarding' or s.phase=='riding' then
        allocate(s,player)
        local riding=true
        for _,person in ipairs(ordered(s)) do
            budget=board(s,person,hooks,budget)
            if person.phase~='riding' then riding=false end
        end
        for _,car in ipairs(s.cars) do budget=follow(s,car,player,budget) end
        s.phase=riding and 'riding' or 'boarding'
    elseif s.phase=='exiting' or s.phase=='recovering' then
        for _,car in ipairs(s.cars) do
            if not car.deleteRequested and not car.pendingCommand and releaseCommand(s,car) and not car.braked and (car.brakeAttempts or 0)<MAX_ATTEMPTS
                and s.clock>=(car.brakeAt or 0) then
                car.brakeAttempts=(car.brakeAttempts or 0)+1; car.brakeAt=s.clock+2
                local braked,brakeError=safe(s.api.brake,car)
                car.braked=braked==true
                if brakeError then car.error=brakeError end
            end
        end
        local positions=s.recoveryPositions or {}
        for _,person in ipairs(ordered(s)) do budget=leave(s,person,player,hooks,budget,positions) end
        local done=true
        for _,person in pairs(s.people) do if person.owned then done=false; break end end
        if done then s.phase='on-foot'; s.primary=nil; s.people={}; s.exitReason=nil end
    end
    cleanup(s)
end
function M.owns(s,serial)
    return s.people[serial] and s.people[serial].owned==true or false
end
-- Call only AFTER the owning companion has been successfully deleted, or when
-- it detached/died. The native command owner no longer exists in that case.
function M.remove(s,serial)
    if s.chauffeur and s.chauffeur.serial==serial then M.cancelChauffeur(s,'The selected companion is unavailable.') end
    if s.people[serial] then s.people[serial]=nil; s.replan=true end
end
function M.removing(s,serial)
    if not s.people[serial] then return end
    s.people[serial].removing=true
    if s.chauffeur then M.cancelChauffeur(s,'The selected companion is leaving.'); return end
    startExit(s,'companion-dismissed')
end
function M.fastTravel(s) s.fastTravelPending=true end
-- Called before native teleportation while owners are still valid. Only IDs,
-- command identity receipts and ordinary values survive the loading interval.
function M.suspend(s)
    if s.chauffeur then chauffeur(s).interrupt(s,'Fast travel cancelled the companion trip.') end
    local receipt={cars={},people={}}
    local function carReceipt(car)
        releaseCommand(s,car)
        return {id=car.id,entityID=car.entityID,owned=car.owned==true,
            record=car.record,appearance=car.appearance,name=car.name,
            ordinal=car.ordinal,driver=car.driver,everAttached=car.everAttached,
            deleteRequested=car.deleteRequested==true,
            command=s.api.commandReceipt(car.command)}
    end
    if s.primary then receipt.primary=carReceipt(s.primary) end
    for _,car in ipairs(s.cars) do receipt.cars[#receipt.cars+1]=carReceipt(car) end
    for serial,person in pairs(s.people) do
        releaseCommand(s,person)
        receipt.people[serial]={vehicle=person.vehicle and person.vehicle.id,seat=person.seat,
            command=s.api.commandReceipt(person.command)}
    end
    M.abandon(s)
    return receipt
end
function M.resume(s,receipt,entries,system)
    local cars={}
    for _,row in ipairs(receipt.cars or {}) do
        local car,err=safe(s.api.rebindVehicle,row,system)
        if car then cars[car.id]=car; s.cars[#s.cars+1]=car
        elseif err then s.error=err end
    end
    if receipt.primary then
        s.primary=cars[receipt.primary.id] or safe(s.api.rebindVehicle,receipt.primary,system)
    end
    acquired(s,entries)
    for _,entry in ipairs(entries) do
        local row=receipt.people and receipt.people[entry.serial]
        local person=s.people[entry.serial]
        if row and not entry.transitRecreated then
            person.vehicle=cars[row.vehicle] or (s.primary and s.primary.id==row.vehicle and s.primary or nil)
            person.seat=row.seat
            person.command=s.api.retiredCommand(row.command,entry.npc,false)
        end
    end
    startExit(s,'fast-travel')
end
function M.abandon(s)
    -- Session teardown cannot query already destroyed native components.
    s.generation=s.generation+1; s.people={}; s.cars={}; s.primary=nil
    s.phase='on-foot'; s.fastTravelPending=nil; s.replan=nil; s.error=nil
    s.chauffeur=nil; s.lastChauffeur=nil
    s.events={}; s.clock=0
end
function M.snapshot(s,serial)
    local rows={}
    for _,person in ipairs(ordered(s)) do
        if not serial or serial==person.entry.serial then
            rows[#rows+1]={serial=person.entry.serial,phase=person.phase,owned=person.owned,
                vehicle=person.vehicle and person.vehicle.id,seat=person.seat,error=person.error,
                attempts=person.attempts,mounted=person.mount and person.mount.vehicle,
                mountedSeat=person.mount and person.mount.seat}
        end
    end
    local cars={}
    for _,car in ipairs(s.cars) do cars[#cars+1]={id=car.id,name=car.name,record=car.record,
        driver=car.driver,following=car.command~=nil,error=car.error,retired=car.retired} end
    return {phase=s.phase,generation=s.generation,error=s.error,people=rows,cars=cars,events=s.events,
        chauffeur=M.chauffeurSnapshot(s)}
end
return M
