-- Menu operations reserve party places while the world is paused. The only
-- world mutation boundary is flush(), called after gameplay has resumed.
local M = {}

function M.new(companions, readiness)
    local Q = {}
    local owner, sequence, joins, leaves = nil, 0, {}, {}
    local attaching, notices = {}, {}
    local feedback = ''

    local function report(message, failed)
        feedback = message
        notices[#notices + 1] = {message = message, failed = failed == true}
    end

    function Q.bind(identity)
        local changed = readiness and readiness.bind(identity) == true
        if identity ~= owner or changed then
            owner, joins, leaves, feedback = identity, {}, {}, ''
            attaching, notices = {}, {}
            return true
        end
        return false
    end

    function Q.message() return feedback end

    function Q.takeNotices()
        local result = notices
        notices = {}
        return result
    end

    local function preparation(job)
        if job.error then return {state = 'error', error = job.error} end
        if not readiness then return {state = 'ready'} end
        local called, state = pcall(readiness.status, job)
        if not called or type(state) ~= 'table' then
            return {state = 'error', error = 'Companion preparation is unavailable.'}
        end
        if state.state ~= 'memory' and state.state ~= 'connecting' and state.state ~= 'ready'
            and state.state ~= 'model-only' and state.state ~= 'error' then
            return {state = 'error', error = 'Companion preparation returned an invalid state.'}
        end
        return state
    end

    function Q.list()
        Q.bind(owner)
        local result = {}
        for _, member in ipairs(companions.list()) do
            local item = {}
            for key, value in pairs(member) do item[key] = value end
            item.id = 'live:' .. member.serial
            if leaves[member.serial] then item.state = 'leaving' end
            result[#result + 1] = item
        end
        local states = {memory = 'preparing-memory', connecting = 'connecting', ready = 'ready-to-join',
            ['model-only'] = 'ready-to-join', error = 'failed'}
        for _, job in ipairs(joins) do
            local status = preparation(job)
            result[#result + 1] = {id = job.id, key = job.key, name = job.name, revision = job.revision,
                record = job.record, profileKey = job.profileKey, profileName = job.profileName,
                state = readiness and states[status.state] or (job.error and 'failed' or 'queued'), error = status.error}
        end
        return result
    end

    function Q.count()
        Q.bind(owner)
        local count = #joins
        for _, member in ipairs(companions.list()) do
            if not leaves[member.serial] then count = count + 1 end
        end
        return count
    end

    local function find(id)
        for _, member in ipairs(Q.list()) do if member.id == id then return member end end
    end

    local function prepare(job)
        if not readiness then return true end
        local called, ok, reason = pcall(readiness.prepare, job)
        if not called or ok ~= true then
            job.error = tostring(called and reason or ok)
            return false, job.error
        end
        return true
    end

    function Q.invite(key)
        Q.bind(owner)
        if not owner then return false, 'Load a save before inviting a companion.' end
        local definition = companions.definition(key)
        if not definition then return false, 'That character model is unavailable.' end
        if Q.count() >= 8 then return false, 'Your party has eight copies. Dismiss one first.' end
        sequence = sequence + 1
        local id = 'queued:' .. sequence
        if readiness and readiness.newId then
            local reason; id, reason = readiness.newId(sequence)
            if not id then return false, reason end
        end
        local job = {id = id, revision = 1, key = key, name = definition.name,
            record = definition.id, profileKey = definition.profileKey,
            profileName = definition.profileName or definition.name}
        joins[#joins + 1] = job
        local ok, reason = prepare(job)
        if not ok then
            report(job.name .. ' could not prepare: ' .. reason, true)
            return false, feedback
        end
        feedback = readiness and (job.name .. (job.profileKey and ' is preparing memory and conversation.'
            or ' is ready to join when you return to the game.')) or (job.name .. ' will join when you return to the game.')
        return true, feedback
    end

    function Q.dismiss(id)
        local member = find(id)
        if not member then return false, 'That copy is no longer in your party.' end
        if member.serial then
            leaves[member.serial] = true
            if attaching[member.serial] and readiness then readiness.cancel(attaching[member.serial]) end
            feedback = member.name .. ' will leave when you return to the game.'
        else
            for index, job in ipairs(joins) do
                if job.id == id then
                    if readiness then readiness.cancel(job) end
                    table.remove(joins, index); break
                end
            end
            feedback = member.name .. ': invitation cancelled.'
        end
        return true, feedback
    end

    function Q.undoDismiss(id)
        local member = find(id)
        if not member or not member.serial or not leaves[member.serial] then
            return false, 'That dismissal is no longer pending.'
        end
        if Q.count() >= 8 then return false, 'Cancel an invitation first; the party is full.' end
        leaves[member.serial] = nil
        feedback = member.name .. ' will stay in the party.'
        return true, feedback
    end

    function Q.assign(id, key, name)
        local member = find(id)
        if not member or member.state == 'leaving' then return false, 'Choose an active or invited copy.' end
        if member.serial then
            -- Conversation identity is Lua data, so it can change while paused.
            local ok, err = companions.setProfile(member.serial, key, name)
            if not ok then return false, err end
            local job = attaching[member.serial]
            if job then
                job.profileKey, job.profileName, job.revision = key, name or job.name, job.revision + 1
                job.error, job.preparationError = nil, nil
                local prepared, reason = prepare(job)
                if not prepared then return false, reason end
                if readiness then readiness.spawned(job, member.serial) end
            end
        else
            for _, job in ipairs(joins) do
                if job.id == id then
                    job.profileKey, job.profileName, job.revision = key, name or job.name, job.revision + 1
                    job.error, job.preparationError = nil, nil
                    local ok, reason = prepare(job)
                    if not ok then feedback = member.name .. ' could not prepare: ' .. reason; return false, feedback end
                    break
                end
            end
        end
        feedback = member.name .. ': ' .. (name and ('conversation set to ' .. name .. '.') or 'conversation profile cleared.')
        return true, feedback
    end

    function Q.flush()
        Q.bind(owner)
        if not owner then return end
        -- CreateEntity only accepts the request. Keep the original reservation
        -- until attachment succeeds, fails or is explicitly dismissed.
        local live = {}
        for _, member in ipairs(companions.list()) do live[member.serial] = member end
        for serial, job in pairs(attaching) do
            local member = live[serial]
            if leaves[serial] then
                if readiness then readiness.cancel(job) end
                attaching[serial] = nil
            elseif member and member.state == 'ready' then
                if readiness then readiness.finish(job) end
                report(member.name .. ' joined your group.' .. (job.warning and (' ' .. job.warning) or ''))
                attaching[serial] = nil
            elseif not member or member.state == 'failed' or member.state == 'missing' then
                if readiness then readiness.cancel(job) end
                report(job.name .. ' could not join: ' ..
                    (member and member.error or 'The character was removed before joining.'), true)
                attaching[serial] = nil
            end
        end
        -- Deletions run first; a failed deletion still occupies its real slot.
        for _, member in ipairs(companions.list()) do
            if leaves[member.serial] then
                local called, ok, err = pcall(companions.dismiss, member.serial)
                leaves[member.serial] = nil
                report(called and ok and (member.name .. ' dismissed.')
                    or (member.name .. ': ' .. tostring(called and err or ok)), not (called and ok))
            end
        end
        local remaining = {}
        for _, job in ipairs(joins) do
            local status = preparation(job)
            if not job.error and (status.state == 'ready' or status.state == 'model-only') then
                local called, serial, err = pcall(companions.spawn, job.key, job)
                if called and serial then
                    local assigned, assignmentError = companions.setProfile(serial, job.profileKey, job.profileName)
                    job.warning = not assigned and tostring(assignmentError) or nil
                    attaching[serial] = job
                    if readiness then readiness.spawned(job, serial) end
                    feedback = assigned and (job.name .. ' is joining your party.')
                        or (job.name .. ': ' .. tostring(assignmentError))
                else
                    job.error = tostring(called and err or serial)
                    if readiness then readiness.cancel(job) end
                    report(job.name .. ' could not join: ' .. job.error, true)
                    remaining[#remaining + 1] = job
                end
            else
                if status.state == 'error' and job.preparationError ~= status.error then
                    job.preparationError = status.error
                    report(job.name .. ' could not prepare: ' .. tostring(status.error), true)
                elseif status.state ~= 'error' then job.preparationError = nil end
                remaining[#remaining + 1] = job
            end
        end
        joins = remaining
    end

    return Q
end

return M
