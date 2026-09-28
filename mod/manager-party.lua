-- Menu operations reserve party places while the world is paused. The only
-- world mutation boundary is flush(), called after gameplay has resumed.
local M = {}

function M.new(companions)
    local Q = {}
    local owner, sequence, joins, leaves = nil, 0, {}, {}
    local attaching, notices = {}, {}
    local feedback = ''

    local function report(message, failed)
        feedback = message
        notices[#notices + 1] = {message = message, failed = failed == true}
    end

    function Q.bind(identity)
        if identity ~= owner then
            owner, joins, leaves, feedback = identity, {}, {}, ''
            attaching, notices = {}, {}
        end
    end

    function Q.message() return feedback end

    function Q.takeNotices()
        local result = notices
        notices = {}
        return result
    end

    function Q.list()
        local result = {}
        for _, member in ipairs(companions.list()) do
            local item = {}
            for key, value in pairs(member) do item[key] = value end
            item.id = 'live:' .. member.serial
            if leaves[member.serial] then item.state = 'leaving' end
            result[#result + 1] = item
        end
        for _, job in ipairs(joins) do
            result[#result + 1] = {id = job.id, key = job.key, name = job.name,
                record = job.record, profileKey = job.profileKey, profileName = job.profileName,
                state = job.error and 'failed' or 'queued', error = job.error}
        end
        return result
    end

    function Q.count()
        local count = #joins
        for _, member in ipairs(companions.list()) do
            if not leaves[member.serial] then count = count + 1 end
        end
        return count
    end

    local function find(id)
        for _, member in ipairs(Q.list()) do if member.id == id then return member end end
    end

    function Q.invite(key)
        if not owner then return false, 'Load a save before inviting a companion.' end
        local definition = companions.definition(key)
        if not definition then return false, 'That character model is unavailable.' end
        if Q.count() >= 8 then return false, 'Your party has eight copies. Dismiss one first.' end
        sequence = sequence + 1
        local job = {id = 'queued:' .. sequence, key = key, name = definition.name,
            record = definition.id, profileKey = definition.profileKey,
            profileName = definition.profileName or definition.name}
        joins[#joins + 1] = job
        feedback = job.name .. ' will join when you return to the game.'
        return true, feedback
    end

    function Q.dismiss(id)
        local member = find(id)
        if not member then return false, 'That copy is no longer in your party.' end
        if member.serial then
            leaves[member.serial] = true
            feedback = member.name .. ' will leave when you return to the game.'
        else
            for index, job in ipairs(joins) do
                if job.id == id then table.remove(joins, index); break end
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
        else
            for _, job in ipairs(joins) do
                if job.id == id then job.profileKey, job.profileName = key, name or job.name end
            end
        end
        feedback = member.name .. ': ' .. (name and ('conversation set to ' .. name .. '.') or 'conversation profile cleared.')
        return true, feedback
    end

    function Q.flush()
        if not owner then return end
        -- CreateEntity only accepts the request. Follow attachment through to a
        -- usable NPC (or its failure) before confirming the invitation.
        local live = {}
        for _, member in ipairs(companions.list()) do live[member.serial] = member end
        for serial, job in pairs(attaching) do
            local member = live[serial]
            if leaves[serial] then
                attaching[serial] = nil
            elseif member and member.state == 'ready' then
                report(member.name .. ' joined your group.' .. (job.warning and (' ' .. job.warning) or ''))
                attaching[serial] = nil
            elseif not member or member.state == 'failed' or member.state == 'missing' then
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
            if not job.error then
                local called, serial, err = pcall(companions.spawn, job.key)
                if called and serial then
                    local assigned, assignmentError = companions.setProfile(serial, job.profileKey, job.profileName)
                    attaching[serial] = {name = job.name, warning = not assigned and tostring(assignmentError) or nil}
                    feedback = assigned and (job.name .. ' is joining your party.')
                        or (job.name .. ': ' .. tostring(assignmentError))
                else
                    job.error = tostring(called and err or serial)
                    report(job.name .. ' could not join: ' .. job.error, true)
                    remaining[#remaining + 1] = job
                end
            else remaining[#remaining + 1] = job end
        end
        joins = remaining
    end

    return Q
end

return M
