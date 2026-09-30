-- Bounded read-only development trace. Reuse existing adapter delegates;
-- diagnostics loaded after init must not register additional CET events.
-- No actor, native component, identity or conversation text enters the report.
local module = {}
local pack = function(...) return {n = select('#', ...), ...} end
local unpackValues = table.unpack or unpack
local phases = {idle=0, starting=1, ready=2, buffering=3, playing=4, paused=5,
    draining=6, ended=7, finished=8, error=9, stopped=10, cancelled=11,
    ['waiting-for-audio']=12, ['holding-boundary']=13}
local reasons = {completed=true, cancelled=true, replaced=true, deadline=true,
    ['row-limit']=true, ['delegate-error']=true, unloaded=true, shutdown=true, interrupted=true}
local function finite(value)
    return type(value) == 'number' and value == value and math.abs(value) < math.huge
end
local function numeric(value) return finite(value) and value or nil end

function module.new(options)
    options = options or {}
    local speech, face = assert(options.speech, 'Speech lifecycle unavailable'), assert(options.face, 'Facial lifecycle unavailable')
    local clock, wall = options.clock or os.clock, options.wall or os.time
    local publish = options.publish or function(value)
        local raw = json.encode(value)
        assert(#raw <= 2097152, 'Cadence report exceeds its size limit')
        local file = assert(io.open('runtime/speech-cadence-probe.json', 'wb'))
        local written, closed = file:write(raw), file:close()
        assert(written and closed, 'Cadence report could not be written')
    end
    local P = {version=1, active=false}

    local function unhook()
        for _, hook in ipairs(P.hooks or {}) do
            if hook.owner[hook.key] == hook.wrapped then hook.owner[hook.key] = hook.original end
        end
        P.hooks = nil
    end

    local function finish(reason)
        if not P.active then return end
        P.active, P.state, P.ownedRequest = false, reasons[reason] and reason or 'interrupted', nil
        unhook()
        local value = {version=1, state=P.state, rows=P.rows,
            phases=phases, started=P.started == true, elapsed=math.max(0, clock()-P.armedClock),
            updates=P.updates, pauseForWorldCalls=P.pauseCalls, syncCalls=P.syncCalls,
            appliedFrames=P.appliedFrames, sameTargetUpdates=P.sameTargetUpdates,
            publicationChanges=P.publicationChanges, rowLimit=P.rowLimit}
        -- A diagnostic failure must not change the delegate's original result.
        P.published = pcall(publish, value)
    end

    function P.stop(reason)
        -- Explicit cancellation can restore delegates even during an idle menu.
        finish(reason or 'cancelled')
    end

    local function endAfterTick(reason)
        if P.inTick then P.pendingFinish = reason else finish(reason) end
    end

    local function observeAfter(call, result, ...)
        if not P.active then return end
        local ok = pcall(call, result, ...)
        if not ok then endAfterTick('delegate-error') end
    end

    local function install(owner, key, observe)
        local original = assert(owner[key], 'Missing lifecycle delegate: '..key)
        assert(type(original) == 'function', 'Invalid lifecycle delegate: '..key)
        local epoch = P.epoch
        local hook = {owner=owner,key=key,original=original}
        hook.wrapped = function(...)
            if not P.active or P.epoch ~= epoch then return original(...) end
            local result = pack(pcall(original, ...))
            observeAfter(observe, result, ...)
            if not result[1] then
                finish('delegate-error')
                error(result[2], 0)
            end
            return unpackValues(result, 2, result.n)
        end
        P.hooks[#P.hooks+1] = hook
        owner[key] = hook.wrapped
    end

    local function sample(delta, elapsedCall)
        if not P.active then return end
        P.updates = P.updates + 1
        if not P.started and speech.requestId then
            P.started, P.ownedRequest, P.captureClock = true, speech.requestId, clock()
        end
        if not P.started then
            if wall() >= P.deadline then finish('deadline') end
            return
        end
        if speech.requestId and speech.requestId ~= P.ownedRequest then finish('replaced');return end
        local read = type(speech.diagnosticCadence) == 'function' and speech.diagnosticCadence() or nil
        local applied = numeric(face.applied) or 0
        local row = {at=math.max(0,clock()-P.captureClock), dt=numeric(delta),
            delegateSeconds=numeric(elapsedCall), phase=phases[speech.state] or -1,
            facePhase=phases[face.state] or -1, paused=speech.paused == true,
            syncCalls=P.tickSyncCalls, applied=P.tickApplied,
            appliedTotal=applied, facePosition=numeric(face.position),
            target=numeric(speech.continuousFaceTarget), cursor=numeric(speech.continuousFaceCursor),
            pauseForWorldCalls=P.pauseCalls}
        local feature = face.feature
        if feature then
            row.jaw=numeric(feature.jaw_mid_open)
            row.apartUp=numeric(feature.lips_apart_up)
            row.apartDown=numeric(feature.lips_apart_dn)
        end
        if type(read) == 'table' then
            row.reads, row.acceptedReads = numeric(read.reads), numeric(read.acceptedReads)
            row.publicationUpdated, row.publicationPosition = numeric(read.updated), numeric(read.position)
            row.duration, row.sourceFrames = numeric(read.duration), numeric(read.sourceFrames)
            row.complete, row.wait, row.poll = read.sourceComplete == true, numeric(read.wait), numeric(read.poll)
            if row.publicationUpdated and row.publicationUpdated ~= P.lastPublication then
                P.publicationChanges=P.publicationChanges+1
                P.lastPublication=row.publicationUpdated
            end
        end
        if row.target and row.target == P.lastTarget then P.sameTargetUpdates=P.sameTargetUpdates+1 end
        P.lastTarget=row.target
        P.rows[#P.rows+1]=row
        if #P.rows >= P.rowLimit then finish('row-limit')
        elseif P.pendingFinish then finish(P.pendingFinish)
        elseif not speech.requestId then finish('completed')
        elseif row.at >= P.captureLimit or wall() >= P.deadline then finish('deadline') end
    end

    function P.start(settings)
        settings=settings or {}
        if P.active then finish('replaced') end
        P.epoch = (P.epoch or 0) + 1
        local epoch = P.epoch
        P.rows, P.hooks, P.state, P.active = {}, {}, 'armed', true
        P.updates, P.pauseCalls, P.syncCalls, P.appliedFrames = 0, 0, 0, 0
        P.sameTargetUpdates, P.publicationChanges = 0, 0
        P.tickSyncCalls, P.tickApplied = 0, 0
        P.started, P.ownedRequest, P.pendingFinish, P.lastTarget, P.lastPublication = false, nil, nil, nil, nil
        P.armedClock, P.deadline = clock(), wall()+120
        P.rowLimit, P.captureLimit = 2400, 20
        local ok, problem = pcall(function()
            for _, key in ipairs({'stop','abandon','pauseForWorld'}) do
                install(speech,key,function(_,reason)
                    if key=='pauseForWorld' then
                        P.pauseCalls=P.pauseCalls+1
                        if wall() >= P.deadline then endAfterTick('deadline') end
                    elseif key=='abandon' then endAfterTick('unloaded')
                    elseif reason=='shutdown' then endAfterTick('shutdown')
                    elseif P.started then
                        endAfterTick(reason=='finished' and 'completed' or 'interrupted')
                    end
                    -- Speech.start clears the old idle controller with stop()
                    -- before assigning the first request. Keep an armed probe.
                end)
            end
            -- Face calls execute within the existing speech update; their actor
            -- arguments are passed through and never stored in this probe.
            local originalSync=assert(face.sync,'Facial sync unavailable')
            local syncHook={owner=face,key='sync',original=originalSync}
            syncHook.wrapped=function(...)
                if not P.active or P.epoch ~= epoch then return originalSync(...) end
                local before=numeric(face.applied) or 0
                local result=pack(pcall(originalSync,...))
                P.syncCalls, P.tickSyncCalls=P.syncCalls+1,P.tickSyncCalls+1
                local count=math.max(0,(numeric(face.applied) or 0)-before)
                P.appliedFrames,P.tickApplied=P.appliedFrames+count,P.tickApplied+count
                if not result[1] then finish('delegate-error');error(result[2],0) end
                return unpackValues(result,2,result.n)
            end
            P.hooks[#P.hooks+1]=syncHook;face.sync=syncHook.wrapped
            local originalUpdate=assert(speech.update,'Speech update unavailable')
            local updateHook={owner=speech,key='update',original=originalUpdate}
            updateHook.wrapped=function(delta,...)
                if not P.active or P.epoch ~= epoch then return originalUpdate(delta,...) end
                if P.active and P.started and speech.requestId and speech.requestId ~= P.ownedRequest then
                    finish('replaced')
                end
                if not P.active then return originalUpdate(delta,...) end
                -- Capture the owner before the delegate: even a short reply can
                -- start and finish within this single existing adapter tick.
                if not P.started and speech.requestId then
                    P.started,P.ownedRequest,P.captureClock=true,speech.requestId,clock()
                end
                P.inTick,P.tickSyncCalls,P.tickApplied=true,0,0
                local before=clock()
                local result=pack(pcall(originalUpdate,delta,...))
                local elapsed=clock()-before
                P.inTick=false
                if not result[1] then finish('delegate-error');error(result[2],0) end
                local sampled=pcall(sample,delta,elapsed)
                if not sampled then finish('delegate-error') end
                return unpackValues(result,2,result.n)
            end
            P.hooks[#P.hooks+1]=updateHook;speech.update=updateHook.wrapped
        end)
        if not ok then finish('delegate-error');error(problem,0) end
        return true
    end

    return P
end

return module
