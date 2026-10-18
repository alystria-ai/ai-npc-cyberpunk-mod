-- Party transport owns movement only between the release and resume handoffs.
-- Policy is native-free and runs against the same adapter contract in tests.
local catalog=dofile('companion-vehicle-catalog.lua')
local M={}
local stopChauffeurConvoy
local MAX_ATTEMPTS=3
local BOARD_TIMEOUT,EXIT_TIMEOUT,ATTACH_TIMEOUT=20,12,12
local EXIT_RETRY=10
local function terminal(state)
    return state=='Success' or state=='Failure' or state=='Cancelled' or state=='Interrupted' or state=='Detached'
end
local function safe(fn,...)
    local ok,a,b,c=pcall(fn,...)
    if not ok then return nil,tostring(a) end
    return a,b,c
end
local function emit(s,event,person,mode)
    if #s.events>=32 then table.remove(s.events,1) end
    s.events[#s.events+1]={at=s.clock,event=event,serial=person and person.entry.serial,generation=s.generation,mode=mode}
end
-- One probe.log line per decision (the owner of the fleet sets s.report; companions.lua writes 'Companion recovery vehicle-<kind>').
-- Rare events only (a boarding, a seat, an exit), never per frame. Fields are plain strings, numbers and lists.
local function report(s,kind,fields)
    if type(s.report)=='function' then pcall(s.report,kind,fields) end
end
local function who(person) return person.entry.name or person.entry.key or tostring(person.entry.serial) end
-- One line per exit decision of each person, not per tick: the line repeats only when the decision changes.
local function exitNote(s,person,key,fields)
    if person.exitNote==key then return end
    person.exitNote=key
    fields=fields or {}
    fields.name,fields.decision=who(person),key
    if fields.seat==nil then fields.seat=person.seat end
    report(s,'exit',fields)
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
    if s.chauffeur then chauffeur(s).autodriveToggled(s,enabled)
    elseif enabled==false then M.taxiArrived(s) end
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
-- The Delamain cab drives itself: cached once per car, only when the adapter can tell.
local function isTaxi(s,car)
    if car.taxi==nil and car.info and car.info.ready then
        local taxi=s.api.isTaxi and safe(s.api.isTaxi,car)
        car.taxi=taxi==true
    end
    return car.taxi==true
end
local function seats(vehicle,taxi)
    local list={}
    for _,seat in ipairs(vehicle.info and vehicle.info.seats or {}) do list[#list+1]=seat end
    local rank={seat_front_left=0,seat_front_right=1,seat_back_left=2,seat_back_right=3}
    -- A taxi seats guests away from the back right seat: the game's own Johnny can appear there (a scene seats him beside V, on top of
    -- a companion already seated, and no cheap check says when), so it is the last choice. The driver seat is never offered.
    if taxi then rank={seat_back_left=0,seat_front_right=1,seat_back_right=2,seat_front_left=3} end
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
-- Followers another mod seats in V's car (docs/COMPANION_VEHICLES_DESIGN.md, "Other mods' riders"). They never join our party,
-- and whatever mounts them (their mod, or the engine's follower AI) picks seats without asking who sits where: Night City Allies
-- gives the front passenger seat to one rider, then the next free passenger seats in the vehicle's own seat order, one per
-- rider. A seat of ours that it picks ends up with two bodies in it. Two layers keep us out of the way:
--   * the PLAN: the seats that default order will use are kept out of our choice (a plan, made once per boarding from the seats
--     free at that moment, which never changes while it stands: a seat that fills up must not move the hold to the next one);
--   * the WAIT: the plan can be wrong (favourite seats, a mod that does not follow that order, the engine mounting followers
--     itself), so while any counted rider still stands outside a vehicle our companions send no mount command, spawn no overflow
--     car and choose no seat for good. The wait ends when every counted rider is seated or gone, or after FOREIGN_SETTLE
--     seconds; the seats are then chosen from what is actually occupied or reserved, which is what the pre-mount check in
--     `board` sees anyway. Without the adapter's foreignPending only the plan applies, for FOREIGN_HOLD seconds.
-- A companion left without a seat takes the ordinary no-free-seat path (the overflow car, or waiting).
local FOREIGN_HOLD,FOREIGN_SETTLE,FOREIGN_POLL=25,12,.5
local FOREIGN_SEATS={seat_front_right=true,seat_back_left=true,seat_back_right=true}
local FOREIGN_FIRST='seat_front_right'
local function foreignPlan(vehicle,riders)
    local free={}
    for _,seat in ipairs(vehicle.info and vehicle.info.seats or {}) do
        if FOREIGN_SEATS[seat.name] and not seat.occupant then free[#free+1]=seat.name end
    end
    local held,count={},0
    for _,name in ipairs(free) do
        if name==FOREIGN_FIRST and count<riders then held[name]=true; count=count+1 end
    end
    for _,name in ipairs(free) do
        if count>=riders then break end
        if not held[name] then held[name]=true; count=count+1 end
    end
    return held
end
local function foreignHeld(s,vehicle,seat)
    local plan=s.foreign
    if not plan or plan.held[seat]~=true or vehicle~=s.primary or plan.settled then return false end
    return s.clock<plan.expires
end
local function foreignSettling(s)
    local plan=s.foreign
    return plan~=nil and plan.waits==true and not plan.settled
end
local function heldNames(plan)
    local names={}
    for name in pairs(plan.held) do names[#names+1]=name end
    table.sort(names)
    return names
end
local function available(s,vehicle,seat,person)
    local ownId=person and tostring(person.entry.entityID.hash)
    return (not seat.occupant or seat.occupant==ownId)
        and (not seat.reserved or seat.occupant==ownId)
        and not reserved(s,vehicle,seat.name,person)
        and (seat.occupant==ownId or not foreignHeld(s,vehicle,seat.name))
end
local function assign(s,person,vehicle,seat)
    person.vehicle,person.seat=vehicle,seat
    person.phase='waiting-to-board'
    person.attempts,person.retryAt,person.error=0,nil,nil
    emit(s,'seat-reserved',person)
    if s.foreign and s.foreign.logged then
        report(s,'seat',{name=who(person),seat=seat,car=vehicle==s.primary and 'V' or ('party car '..tostring(vehicle.ordinal))})
    end
end
-- A companion who never drives (catalog.passengerOnly: Alt Cunningham) is seated first, so she takes a seat in V's car
-- before anyone who could drive an overflow car; the rest keep their serial order.
local function pending(s)
    local list,passengers={},{}
    for _,person in ipairs(ordered(s)) do
        if person.owned and not person.vehicle then
            if catalog.drives(person.entry) then list[#list+1]=person else passengers[#passengers+1]=person end
        end
    end
    for index,person in ipairs(passengers) do table.insert(list,index,person) end
    return list
end
local function fill(s,vehicle)
    if not vehicle.info or not vehicle.info.ready then return end
    for _,seat in ipairs(seats(vehicle,isTaxi(s,vehicle))) do
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
    local rows={}
    for _,person in ipairs(ordered(s)) do
        if person.owned then
            local at=person.mount and (tostring(person.mount.seat)..(s.primary and person.mount.vehicle==s.primary.id and '@V' or '@other')) or 'not mounted'
            rows[#rows+1]={name=who(person),seat=person.seat or 'none',phase=person.phase,mounted=at}
        end
    end
    for _,person in pairs(s.people) do
        person.phase='leaving'; person.attempts=0; person.retryAt=nil
        person.recovered=nil; person.recoverAttempts=nil; person.recoverAt=nil
        person.exitNote,person.failedAt,person.rounds=nil,nil,nil
    end
    emit(s,reason)
    report(s,'exit-start',{reason=reason,people=rows})
end
-- The Delamain cab leaves about 5 s after V is out, so companions start leaving
-- at arrival while V still sits. taxiExit keeps the fleet from boarding again.
function M.taxiArrived(s)
    if s.chauffeur or (s.phase~='boarding' and s.phase~='riding') then return end
    if not s.primary or not isTaxi(s,s.primary) then return end
    s.taxiExit=s.primary.id
    startExit(s,'taxi-arrived')
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
-- One question to the adapter per boarding (a trip, for a chauffeur car): how many of another mod's followers are about to ride
-- in V's car. It is asked when someone first needs a seat and not again for the same boarding: the seats are chosen in that
-- same update. A missing adapter function, a failed read or no answer all mean none: the original seat choice.
local function sampleForeign(s,player)
    local plan=s.foreign
    if plan and plan.generation==s.generation and plan.vehicle==s.primary.id and plan.trip==s.chauffeur then return end
    plan={generation=s.generation,vehicle=s.primary.id,trip=s.chauffeur,riders=0,held={},expires=0}
    s.foreign=plan
    if not s.api.foreignRiders then plan.why='adapter has no foreign-rider read'; return end
    local riders,detail=safe(s.api.foreignRiders,player,s.primary)
    if riders==nil then plan.error=tostring(detail); plan.why='read failed'; return end
    plan.riders=math.max(0,math.floor(tonumber(riders) or 0))
    if type(detail)=='table' then plan.rows,plan.ids,plan.why=detail.rows,detail.ids,detail.why end
    if plan.riders==0 then return end
    plan.held=foreignPlan(s.primary,plan.riders)
    plan.expires=s.clock+FOREIGN_HOLD
    if type(s.api.foreignPending)=='function' and type(plan.ids)=='table' and #plan.ids>0 then
        plan.waits=true; plan.settleUntil=s.clock+FOREIGN_SETTLE; plan.nextPoll=s.clock+FOREIGN_POLL
    end
    emit(s,'foreign-riders',nil,plan.riders)
end
-- While the wait lasts: twice a second, a lookup and a mount read for each counted rider (a few characters, a few seconds).
local function pollForeign(s)
    local plan=s.foreign
    if not foreignSettling(s) then return end
    local why
    if s.clock>=plan.settleUntil then why='timeout'
    elseif s.clock>=plan.nextPoll then
        plan.nextPoll=s.clock+FOREIGN_POLL
        local pending,err=safe(s.api.foreignPending,plan.ids)
        if pending==nil then plan.error=tostring(err); why='unreadable'
        elseif tonumber(pending)<=0 then why='seated' end
    end
    if not why then return end
    plan.settled,plan.settledWhy=true,why
    report(s,'settled',{why=why,waited=math.floor((s.clock-(plan.settleUntil-FOREIGN_SETTLE))*10+.5)/10,error=plan.error})
end
-- The line for the next live check: what the read found, which seats were held, and where each of our companions went.
local function boardingLine(s)
    local plan=s.foreign
    if not plan or plan.logged then return end
    plan.logged=true
    local chosen,seated={},{}
    for _,person in ipairs(ordered(s)) do
        if person.owned then
            chosen[#chosen+1]={name=who(person),seat=person.seat or 'none',
                car=person.vehicle and (person.vehicle==s.primary and 'V' or 'party car') or 'none'}
        end
    end
    for _,seat in ipairs(s.primary.info and s.primary.info.seats or {}) do
        if seat.occupant or seat.reserved then seated[#seated+1]=seat.name..(seat.occupant and '=occupied' or '=reserved') end
    end
    report(s,'boarding',{riders=plan.riders,held=heldNames(plan),waiting=plan.waits==true,why=plan.why,error=plan.error,
        taken=seated,people=chosen,foreign=plan.rows})
end
local function allocate(s,player)
    if not s.primary.info or not s.primary.info.ready then
        s.error='Waiting for the passenger capacity of your vehicle.'; return
    end
    s.error=nil
    if #pending(s)>0 then sampleForeign(s,player) end
    pollForeign(s)
    -- A native follower can have boarded between two samples. Actual mounting
    -- takes precedence over an uncommitted local passenger-seat reservation.
    for _,person in ipairs(pending(s)) do
        local mount=safe(s.api.mounting,person.entry)
        if mount and mount.vehicle==s.primary.id and mount.seat~='seat_front_left'
            and not reserved(s,s.primary,mount.seat,person) then
            assign(s,person,s.primary,mount.seat)
        end
    end
    -- The same for a companion planned for another car whom the engine's follower AI seated in V's car (live 2026-10-19: Alex
    -- sat in V's passenger seat while the fleet waited to board her elsewhere, and she was still there when V got out). The
    -- last mount board() read stands in for a fresh one: no extra native read per person per tick.
    for _,person in ipairs(ordered(s)) do
        local mount=person.owned and not person.removing and person.vehicle and person.vehicle~=s.primary and person.mount
        if mount and mount.vehicle==s.primary.id and mount.seat~='seat_front_left'
            and not reserved(s,s.primary,mount.seat,person) and (not person.command or releaseCommand(s,person)) then
            emit(s,'adopted-in-primary',person)
            assign(s,person,s.primary,mount.seat)
        end
    end
    fill(s,s.primary)
    boardingLine(s)
    -- Nothing past this point (the cab's no-seat message, a spawned party car) before the other mod's followers have sat down:
    -- whoever is left without a seat is decided from the real occupancy afterwards.
    if foreignSettling(s) then return end
    if isTaxi(s,s.primary) then
        -- A self-driving cab has no convoy: whoever finds no seat waits and walks on after the exit.
        for _,person in ipairs(pending(s)) do
            person.error='The Delamain cab has no free seat for this companion.'
        end
        return
    end
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
    -- Runaway guard on cars the mod may create, never a party limit: eight cars
    -- seat 31 companions (three beside V, four per car), and the guard grows with
    -- the number of people travelling so a larger party still gets its cars.
    local travelling=0
    for _ in pairs(s.people) do travelling=travelling+1 end
    if #s.cars>=math.max(8,2+math.ceil(travelling/4)) then s.error='Party vehicle limit reached.'; return end
    local choice,driver=catalog.choose(queue)
    if not driver then
        -- Everyone still waiting is passenger-only: no car is created for them (nobody drives it); they keep waiting for a seat.
        s.error='Waiting for a free passenger seat: this companion does not drive.'; return
    end
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
    if s.api.canResumeWalking then
        local clear,err=safe(s.api.canResumeWalking,person.entry,person.vehicle,person.seat)
        if clear~=true then
            person.phase='waiting-for-native-exit'
            person.error=err or 'Waiting for the native vehicle exit to finish.'
            return
        end
    end
    local done,err=safe(hooks.resumed,person.entry)
    -- A callback returning nil is an ordinary successful Lua callback.
    if err or done==false then person.error=err or 'Waiting for walking ownership to resume.'; return end
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
    local overflowDriver=car~=s.primary and car.driver==person.entry.serial
    -- Native follower AI can claim a passenger slot before our driver mount
    -- finishes. That actor is not a driver yet: retire our exact command,
    -- animate an exit from this same owned car, then retry the driver slot.
    if person.reseating or (overflowDriver and mount and mount.vehicle==car.id and mount.seat~='seat_front_left') then
        if person.command then
            local status=safe(s.api.commandState,person.command)
            if person.reseating and not terminal(status) and s.clock-person.commandAt<=EXIT_TIMEOUT then return budget end
            if not releaseCommand(s,person) then return budget end
        end
        if mount then
            if mount.vehicle~=car.id then person.error='Waiting for the foreign vehicle mount to release.'; return budget end
            if budget<=0 or car.info.speed>0.5 or car.info.scene then return budget end
            if person.attempts>=MAX_ATTEMPTS then person.phase='boarding-failed'; return budget end
            person.attempts=person.attempts+1; person.commandAt=s.clock; person.reseating=true
            local command,err=safe(s.api.mount,person.entry,car,mount.seat,true)
            person.command=command; person.phase='leaving-wrong-seat'; person.error=err
            return budget-1
        end
        if s.api.canResumeWalking then
            local clear,err=safe(s.api.canResumeWalking,person.entry,car,person.seat)
            if clear~=true then person.error=err; return budget end
        end
        person.reseating=nil; person.phase='waiting-to-board'
    end
    local matching=mount and mount.vehicle==car.id and mount.seat==person.seat
    -- Native follower AI can finish a different free passenger seat first.
    -- Adopt only a real seat in this same car, never a driver or a foreign car.
    if not person.chauffeur and not overflowDriver and mount and mount.vehicle==car.id and not matching and mount.seat~='seat_front_left'
        and not reserved(s,car,mount.seat,person) then
        person.seat=mount.seat; matching=true
    end
    if matching then
        if person.command then
            local status,err=safe(s.api.commandState,person.command)
            person.commandState=status
            if not terminal(status) then person.error=err; return budget end
            person.command=nil
        end
        person.phase='riding'; person.error=nil
        return budget
    end
    if mount then person.error='Companion is mounted in another seat or vehicle.'; return budget end
    if person.command then
        local status,err=safe(s.api.commandState,person.command)
        person.commandState=status
        if terminal(status) or s.clock-person.commandAt>BOARD_TIMEOUT then
            if not releaseCommand(s,person) then return budget end
            person.retryAt=s.clock+3; person.phase='boarding-retry'
            person.error=err or 'Boarding did not reach the reserved seat.'
        else
            -- AIMount owns the approach, door and entry animation. Sampling
            -- the same native blocker helps explain a paused approach without
            -- layering a second walk/facing command over it.
            if s.api.canBoard then
                local calm,reason=safe(s.api.canBoard,person.entry)
                person.error=not calm and (reason or 'Waiting for combat to finish before boarding.') or err
            else person.error=err end
            return budget
        end
    end
    if person.attempts>=MAX_ATTEMPTS then person.phase='boarding-failed'; return budget end
    if s.clock<(person.retryAt or 0) or budget<=0 or car.info.speed>0.8 or car.info.scene then return budget end
    if car==s.primary and foreignSettling(s) then
        person.error="Waiting for another mod's followers to take their seats."
        return budget
    end
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
    person.commandState=nil
    local command,err=safe(s.api.mount,person.entry,car,person.seat,false)
    person.command=command; person.phase='boarding'; person.error=err
    if not command then person.retryAt=s.clock+3 end
    emit(s,'mount-requested',person)
    return budget-1
end
local function pauseChauffeurDriver(s,person,hooks)
    -- V temporarily claimed the slot. Cancel only this fleet's exact native
    -- receipt and retain transport ownership until that cancellation is known.
    -- No stop/hold, seat-centre move, passenger mount or player input is sent.
    local released=prepare(s,person,hooks)
    if person.command and not person.driverPauseRefund then
        person.driverPauseRefund=true
    end
    if not releaseCommand(s,person) then return false end
    if not released then return false end
    local mount,known=observeMount(s,person)
    if not known then return false end
    if mount then
        person.error='Waiting for the native vehicle transition to finish.'
        return false
    end
    if person.driverPauseRefund then
        person.attempts=math.max(0,person.attempts-1)
        person.driverPauseRefund=nil
    end
    person.phase='waiting-for-driver-seat'
    person.vehicle=s.chauffeur.car; person.seat='seat_front_left'
    person.retryAt=nil; person.error=nil
    return true
end
local function follow(s,car,player,budget)
    if car==s.primary or car.retired or not car.info or not car.info.ready or car.info.playerMounted then return budget end
    local driver=s.people[car.driver]
    local ready=driver and driver.vehicle==car and driver.phase=='riding' and driver.seat=='seat_front_left'
        and driver.mount and driver.mount.vehicle==car.id and driver.mount.seat=='seat_front_left'
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
    -- Native drive-follow trails another vehicle. In the October 5 test a
    -- convoy told to follow the player puppet (seated in V's car) never moved
    -- through two requests; follow V's own car, the puppet only as fallback.
    local target=s.primary and s.primary.entity
    local attached,ok=false,false
    if target then ok,attached=pcall(function() return target:IsAttached() end) end
    if not ok or not attached then target=player end
    local command,err=safe(s.api.follow,car,target,car.ordinal)
    car.command=command; car.error=err
    if not command then car.retryAt=s.clock+3 end
    emit(s,'convoy-requested',driver,car.followMode)
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
        person.commandState=status
        if person.phase=='unmounting' and not terminal(status) and s.clock-person.commandAt<=EXIT_TIMEOUT then return budget end
        if not releaseCommand(s,person) then return budget end
        person.retryAt=s.clock+2
    end
    if not mount then
        if s.phase=='recovering' and not person.recovered then
            -- The mounting link can clear before the exit workspot. Teleport
            -- only after the same native exit gate used by walking handoff.
            if s.api.canResumeWalking then
                local clear,err=safe(s.api.canResumeWalking,person.entry,person.vehicle,person.seat)
                if clear~=true then person.phase='waiting-for-native-exit'; person.error=err; return budget end
            end
            if s.clock<(person.recoverAt or 0) or (person.recoverAttempts or 0)>=MAX_ATTEMPTS then return budget end
            local attempts,at=person.recoverAttempts,person.recoverAt
            person.recoverAttempts=(person.recoverAttempts or 0)+1; person.recoverAt=s.clock+2
            local done,err,deferred=safe(s.api.recover,person.entry,player,recoveryPositions)
            if deferred then person.recoverAttempts,person.recoverAt=attempts,at; return budget end
            if not done then
                person.phase='recovery-failed'; person.error=err
                -- The last failed placement hands the copy back to walking.
                -- Keeping it owned here left it unplanned with every on-foot
                -- recovery (fast-travel arrival, catch-up, stranded) disarmed;
                -- those place it near V with an AI teleport instead.
                if person.recoverAttempts>=MAX_ATTEMPTS then
                    person.recovered=true; emit(s,'recovery-handed-back',person); finish(s,person,hooks)
                end
                return budget
            end
            -- Native exit/gaze retirement may defer finish(). The successful
            -- relocation belongs to this travel transaction and must not run
            -- again or spend the remaining placement attempts while waiting.
            person.recovered=true
        end
        finish(s,person,hooks); return budget
    end
    local car=person.vehicle
    if not car or mount.vehicle~=car.id then
        -- She sits in a car of the fleet (V's or a party car) other than the one planned for her, because the engine's follower
        -- AI seated her there: her exit is ours to run, from the car she is really in (live 2026-10-19: Alex stayed seated
        -- when V got out). Only a car that is not the fleet's is somebody else's.
        local actual
        if s.primary and s.primary.id==mount.vehicle then actual=s.primary end
        for _,other in ipairs(s.cars) do if other.id==mount.vehicle then actual=other end end
        if actual then
            person.vehicle,person.seat=actual,mount.seat; car=actual
            exitNote(s,person,'exits-from-actual-car',{seat=mount.seat,car=actual==s.primary and 'V' or 'party car'})
        else
            person.error='Companion entered another vehicle; its occupant is left unchanged.'
            -- A foreign mount is not an on-foot handoff. Wait for its native
            -- dismount instead of issuing walking into somebody else's vehicle.
            person.phase='waiting-for-native-dismount'
            exitNote(s,person,'waits-for-foreign-vehicle',{seat=mount.seat})
            return budget
        end
    end
    if budget<=0 or not car.info or not car.info.ready or car.info.speed>0.5 or car.info.scene
        or s.clock<(person.retryAt or 0) then
        if car.info and car.info.ready and (car.info.speed>0.5 or car.info.scene) then
            exitNote(s,person,'waits-for-car',{speed=math.floor((car.info.speed or 0)*10+.5)/10,scene=car.info.scene==true})
        end
        return budget
    end
    if car.command or car.pendingCommand then return budget end
    if person.attempts>=MAX_ATTEMPTS then
        person.phase='exit-failed'
        exitNote(s,person,'exit-failed-'..(person.rounds or 0),{round=person.rounds or 0})
        -- Three refused unmounts are not the end: try again in rounds, ten seconds apart, instead of leaving her seated for good.
        person.failedAt=person.failedAt or s.clock
        if s.clock-person.failedAt<EXIT_RETRY or (person.rounds or 0)>=2 then return budget end
        person.rounds=(person.rounds or 0)+1; person.attempts,person.failedAt=0,nil
    end
    person.attempts=person.attempts+1; person.commandAt=s.clock
    person.commandState=nil
    local command,err=safe(s.api.mount,person.entry,car,mount.seat,true)
    person.command=command; person.phase='unmounting'; person.error=err
    if not command then person.retryAt=s.clock+2 end
    emit(s,'unmount-requested',person)
    exitNote(s,person,'unmount-requested-'..person.attempts..'-'..(person.rounds or 0),{attempt=person.attempts,seat=mount.seat})
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
local function protectChauffeurPassenger(s,player)
    local trip=s.chauffeur
    trip.passengerYieldPending=false
    if trip.phase~='releasing' and trip.phase~='boarding-driver' and trip.phase~='waiting-for-driver-seat'
        and trip.phase~='waiting-for-player'
        and trip.phase~='waiting-for-party' then return end
    local mount,err=safe(s.api.mounting,{npc=player})
    if err then trip.passengerYieldPending=true; return end
    if not mount or mount.vehicle~=trip.car.id or (mount.seat~='seat_front_right'
        and mount.seat~='seat_back_left' and mount.seat~='seat_back_right') then return end
    local actual=false
    for _,row in ipairs(trip.car.info and trip.car.info.seats or {}) do
        if row.name==mount.seat and row.occupant==trip.playerId then actual=true; break end
    end
    if not actual then trip.passengerYieldPending=true; return end
    -- A manually chosen alternate passenger seat takes precedence over our
    -- uncommitted NPC reservation. Retire that exact mount command before
    -- reallocating the companion; never move V or evict an actual occupant.
    for _,person in pairs(s.people) do
        if not person.chauffeur and person.vehicle==trip.car and person.seat==mount.seat then
            if not releaseCommand(s,person) then trip.passengerYieldPending=true
            else
                local other,known=observeMount(s,person)
                if not known or (other and (other.vehicle~=trip.car.id or other.seat==mount.seat)) then
                    trip.passengerYieldPending=true
                elseif other then person.seat=other.seat
                else
                    person.vehicle=nil; person.seat=nil; person.phase='waiting-for-seat'
                    person.attempts=0; person.retryAt=nil
                end
            end
        end
    end
    if not trip.passengerYieldPending then
        -- The immutable offer remains an audit of the requested seat. Current
        -- departure/cleanup uses this separately observed physical seat.
        trip.passengerSeat=mount.seat
    end
end
local function yieldChauffeurToPlayer(s,player,hooks)
    local trip=s.chauffeur
    local person=s.people[trip.serial]
    if person then
        if not releaseCommand(s,person) then return false end
        local mount,known=observeMount(s,person)
        if not known or (mount and mount.vehicle==trip.car.id and mount.seat=='seat_front_left') then return false end
        person.chauffeur=nil
        if not mount then
            finish(s,person,hooks)
            if person.owned then return false end
            s.people[trip.serial]=nil
        elseif mount.vehicle==trip.car.id then
            person.vehicle=trip.car; person.seat=mount.seat; person.phase='riding'
        end
    end
    -- V entered the driver seat through normal gameplay. Preserve the regular
    -- party/carpool owner; there is no player mount, exit or seat-switch call.
    s.phase='boarding'; s.error=nil; s.replan=nil
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
            protectChauffeurPassenger(s,player)
            -- Relaxed native followers leave passenger seats when their
            -- friendly target is on foot (FollowerActions.ExitVehicle).
            -- Keep everyone except the selected driver under ordinary walking
            -- ownership until V has completed manual passenger boarding.
            local partyPhase=trip.phase=='waiting-for-party' or trip.phase=='starting' or trip.phase=='driving'
            local playerMount=partyPhase and safe(s.api.mounting,{npc=player}) or nil
            local partyAdmitted=playerMount and playerMount.vehicle==trip.car.id
                and playerMount.seat==trip.passengerSeat
            if partyAdmitted then
                acquired(s,entries)
                allocate(s,player)
                local budget=1
                for _,person in ipairs(ordered(s)) do
                    if person.entry.serial~=trip.serial then budget=board(s,person,hooks,budget) end
                end
            end
            trip.partyReady=partyAdmitted==true
            for _,person in pairs(s.people) do
                if person.owned and (person.phase~='riding' or person.removing) then trip.partyReady=false end
            end
            if trip.passengerYieldPending then trip.partyReady=false end
        end
        chauffeur(s).update(s,player,entries,hooks,{prepare=prepare,board=board,
            pauseDriver=pauseChauffeurDriver,
            leaveParty=leaveChauffeurParty,yieldToPlayer=yieldChauffeurToPlayer})
        if s.chauffeur then
            if s.chauffeur.phase=='driving' or (s.chauffeur.phase=='starting' and s.chauffeur.partyReady) then
                local budget=2
                for _,car in ipairs(s.cars) do budget=follow(s,car,player,budget) end
            elseif s.chauffeur.phase=='stopping' or s.chauffeur.phase=='waiting-for-player-exit'
                or s.chauffeur.phase=='exiting-driver' then
                stopChauffeurConvoy(s)
                for _,person in pairs(s.people) do
                    if person.command and person.phase~='unmounting' then releaseCommand(s,person) end
                end
            end
        end
        cleanup(s)
        return
    end
    local primary,err=safe(s.api.player,player)
    if err then s.error=err; return end
    if s.taxiExit and (not primary or primary.id~=s.taxiExit) then s.taxiExit=nil end
    if s.fastTravelPending then
        acquired(s,entries); startExit(s,'fast-travel'); s.fastTravelPending=nil
    elseif s.phase=='on-foot' and primary and #entries>0 and not s.taxiExit then begin(s,primary,entries)
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
function M.allowsSeatedAttention(s,serial)
    local person=s.people[serial]
    return person and person.owned==true and person.phase=='riding'
        and not person.command and not person.error or false
end
-- Call only AFTER the owning companion has been successfully deleted, or when
-- it detached/died. The native command owner no longer exists in that case.
-- Only a departing driver changes the plan. A dismissed passenger is simply
-- removed: the others keep their seats, and a chauffeur trip continues.
local function drivesConvoy(s,serial)
    for _,car in ipairs(s.cars) do
        if car~=s.primary and not car.retired and car.driver==serial then return true end
    end
    return false
end
function M.remove(s,serial)
    if s.chauffeur and s.chauffeur.serial==serial then M.cancelChauffeur(s,'The selected companion is unavailable.') end
    if s.people[serial] then
        if drivesConvoy(s,serial) then s.replan=true end
        s.people[serial]=nil
    end
end
function M.removing(s,serial)
    if not s.people[serial] then return end
    s.people[serial].removing=true
    if s.chauffeur and s.chauffeur.serial==serial then
        M.cancelChauffeur(s,'The selected companion is leaving.'); return
    end
    if drivesConvoy(s,serial) then startExit(s,'companion-dismissed') end
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
    s.phase='on-foot'; s.fastTravelPending=nil; s.replan=nil; s.error=nil; s.taxiExit=nil
    s.chauffeur=nil; s.lastChauffeur=nil; s.foreign=nil
    s.events={}; s.clock=0
end
function M.snapshot(s,serial)
    local rows={}
    for _,person in ipairs(ordered(s)) do
        if not serial or serial==person.entry.serial then
            rows[#rows+1]={serial=person.entry.serial,phase=person.phase,owned=person.owned,
                vehicle=person.vehicle and person.vehicle.id,seat=person.seat,error=person.error,
                attempts=person.attempts,mounted=person.mount and person.mount.vehicle,
                mountedSeat=person.mount and person.mount.seat,commandState=person.commandState,
                commandActive=person.command~=nil,
                commandAge=person.commandAt and math.max(0,s.clock-person.commandAt) or nil}
        end
    end
    local cars={}
    for _,car in ipairs(s.cars) do cars[#cars+1]={id=car.id,name=car.name,record=car.record,
        driver=car.driver,following=car.command~=nil,error=car.error,retired=car.retired} end
    return {phase=s.phase,generation=s.generation,error=s.error,people=rows,cars=cars,events=s.events,
        chauffeur=M.chauffeurSnapshot(s)}
end
return M
