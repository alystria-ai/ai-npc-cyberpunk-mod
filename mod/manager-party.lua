-- Menu operations reserve party places while the world is paused. The only
-- world mutation boundary is flush(), called after gameplay has resumed.
local M = {}
local ui = (convaiUiLocale or dofile('ui-locale.lua'))

-- The invitation notice board. Every invitation in flight (manager or phone) is
-- one entry, and the board turns all of them into ONE compact notice that
-- replaces the previous one: "Preparing Judy and Johnny...", then "Judy and
-- Johnny joined your group.". A lone invitation keeps its original wording.
-- Visibility rules: preparing, connecting, ready and joined show, the routine
-- "joining" step is Developer-mode only, and every failure shows, together
-- with the successes.
-- Calm rules, because each notice replaces the last one on screen:
-- * "Preparing" and "Connecting" (the memory check, voice conditioning and
--   connection start) show only once an invitation has been in flight for
--   SHOW_DELAY_MS, so a quick summon goes straight to "joined". The delay is
--   per invitation: a merged notice names only the ones already shown.
-- * A posted notice stays up for at least MIN_SHOW_MS (FINAL_SHOW_MS after a
--   final outcome, so a "joined" is never cut short): a change arriving sooner
--   is held, and whatever is true when the time is up is posted instead
--   (intermediate texts are skipped, a text that reverted meanwhile is never
--   shown). Near-simultaneous stages of several invitations merge the same way.
-- * When one companion has joined and the others of the same burst are still
--   going, the "joined" line waits up to JOIN_HOLD_MS for them, so the usual
--   result is one merged "joined" instead of a partial notice. Meanwhile the
--   progress notice keeps naming everyone it already named.
-- * A new failure and the "ready" lines, which ask the player to act, are never
--   delayed by the show delay; only a new failure also skips the minimum time.
local MIN_SHOW_MS = 3000
local FINAL_SHOW_MS = 5000
local JOIN_HOLD_MS = 4000
local SHOW_DELAY_MS = 1000
local MAX_LISTED = 3
local RANKS = {memory = 1, connecting = 2, ready = 3, joining = 4}

-- Whole wall-clock seconds are exact but coarse; os.clock supplies the fraction.
local function newClock()
    local lastFine, virtual, base = os.clock(), 0, os.time()
    return function()
        local fine = os.clock()
        if fine > lastFine then virtual = virtual + (fine - lastFine) * 1000 end
        lastFine = fine
        local wall = (os.time() - base) * 1000
        if wall > virtual then virtual = wall end
        return virtual
    end
end

local function uniqueNames(items)
    local names, seen = {}, {}
    for _, item in ipairs(items) do
        if item.name and not seen[item.name] then seen[item.name] = true; names[#names + 1] = item.name end
    end
    return names
end

-- "Judy", "Judy and Johnny", "Judy, Johnny and Panam", "Judy, Johnny and 3 others".
local function listNames(names)
    local count = #names
    if count <= 1 then return names[1] or '' end
    if count == 2 then return ui.t('{first} and {second}', {first = names[1], second = names[2]}) end
    if count <= MAX_LISTED then
        return ui.t('{first}, {second} and {third}', {first = names[1], second = names[2], third = names[3]})
    end
    return ui.t('{first}, {second} and {count} others', {first = names[1], second = names[2], count = count - 2})
end

local function newBurst()
    -- gone: invitations that finished, by name, so a held "joined" can still be named in the progress line.
    return {joined = {}, failures = {}, fresh = false, gone = {}}
end

function M.newBoard(options)
    options = options or {}
    local B = {}
    local now = options.now or newClock()
    local entries, burst, sequence = {}, newBurst(), 0
    local shownCore, shownGameplayCore, lastAt, lastWorld, lastHold
    -- Developer diagnosis: every posted notice (with each invitation's stage) and every
    -- ignored stage regression goes to the mod log when init.lua provides one.
    local function note(line)
        local sink = options.log
        -- CET module environments may have no _G; read the global directly and never throw.
        if type(sink) ~= 'function' then
            local ok, global = pcall(function() return convaiNoticeLog end)
            sink = ok and global or nil
        end
        if type(sink) == 'function' then pcall(sink, line) end
    end

    local function developerMode()
        if type(options.developerMode) ~= 'function' then return false end
        local ok, enabled = pcall(options.developerMode)
        return ok and enabled == true
    end

    function B.reset()
        entries, burst = {}, newBurst()
        shownCore, shownGameplayCore, lastAt, lastWorld, lastHold = nil, nil, nil, nil, nil
    end

    -- Start following an invitation. A new one is always announced, even when
    -- its text equals the previous notice (two copies of one character).
    function B.track(id, source)
        if type(id) ~= 'string' then return end
        for _, entry in ipairs(entries) do if entry.id == id then return end end
        sequence = sequence + 1
        entries[#entries + 1] = {id = id, source = source or 'manager', startedAt = now(), seq = sequence}
    end

    -- Completed outcomes handed over by the party queue (joined or failed).
    function B.event(notice)
        local info = type(notice) == 'table' and notice.info or nil
        if type(info) ~= 'table' then return end
        if info.kind == 'joined' then
            burst.joined[#burst.joined + 1] = {name = info.name, message = notice.message, warning = info.warning}
            burst.joinedAt = burst.joinedAt or now()
        elseif info.kind == 'failed' then
            burst.failures[#burst.failures + 1] = {name = info.name, message = notice.message}
        else return end
        burst.fresh = true
    end

    -- Refresh every entry from the queue. Entries the queue no longer lists
    -- (joined, cancelled, removed) are finished; a failed one stays listed but
    -- is no longer in flight, its failure arrives as an event.
    local function sample(worldReady)
        local inflight = {}
        for index = #entries, 1, -1 do
            local entry = entries[index]
            local ok, current = pcall(options.feedback, entry.id)
            if not ok or type(current) ~= 'table' then
                table.remove(entries, index)
                if entry.name then
                    burst.gone[entry.name] = {seq = entry.seq, source = entry.source, name = entry.name,
                        shown = entry.announced ~= nil and entry.announced == entry.revision}
                end
            else
                entry.name, entry.revision = current.name, current.revision
                entry.failed = current.failed == true or current.state == 'error'
                local stage = current.state
                if stage == 'model-only' then stage = 'ready' end
                -- In gameplay a ready invitation is already being created.
                if worldReady and stage == 'ready' then stage = 'joining' end
                stage = RANKS[stage] and stage or 'memory'
                -- Preparation only moves forward within one attempt. A stale or
                -- missing receipt reads as "memory" or "connecting" again for a
                -- moment; that must not flash an earlier stage. (The paused
                -- ready/joining pair legitimately swaps, so only these two count.)
                if entry.stage and entry.sameRevision == entry.revision and (stage == 'memory' or stage == 'connecting')
                    and RANKS[stage] < RANKS[entry.stage] then
                    if entry.ignored ~= stage then
                        entry.ignored = stage
                        note('Invitation ' .. tostring(entry.name) .. ' reported ' .. stage .. ' after ' .. entry.stage .. '; kept ' .. entry.stage)
                    end
                else
                    entry.stage, entry.ignored = stage, nil
                end
                entry.sameRevision = entry.revision
            end
        end
        for _, entry in ipairs(entries) do if not entry.failed then inflight[#inflight + 1] = entry end end
        return inflight
    end

    -- The invitations whose progress may be named now. Preparing and connecting
    -- wait out the show delay; ready and joining never do.
    local function visible(inflight, at)
        local shown = {}
        for _, entry in ipairs(inflight) do
            local routine = entry.stage == 'memory' or entry.stage == 'connecting'
            if not routine or at - (entry.startedAt or at) >= SHOW_DELAY_MS then shown[#shown + 1] = entry end
        end
        return shown
    end

    local function progress(inflight, developer)
        if #inflight == 0 then return nil end
        local lowest, allPhone = 'joining', true
        for _, entry in ipairs(inflight) do
            if RANKS[entry.stage] < RANKS[lowest] then lowest = entry.stage end
            if entry.source ~= 'phone' then allPhone = false end
        end
        if lowest == 'joining' and not developer then return nil end
        local names = uniqueNames(inflight)
        if #names <= 1 then
            local name = names[1]
            if lowest == 'memory' then return ui.t('Preparing {name}…', {name = name}) end
            if lowest == 'connecting' then return ui.t('Connecting {name}…', {name = name}) end
            if lowest == 'ready' then
                return allPhone and ui.t('{name} is ready. Close the phone to join.', {name = name})
                    or ui.t('{name} is ready to join when you return to the game.', {name = name})
            end
            return ui.t('{name} is joining your party.', {name = name})
        end
        local list = listNames(names)
        if lowest == 'memory' then return ui.t('Preparing {names}…', {names = list}) end
        if lowest == 'connecting' then return ui.t('Connecting {names}…', {names = list}) end
        if lowest == 'ready' then
            return allPhone and ui.t('{names} are ready. Close the phone to join.', {names = list})
                or ui.t('{names} are ready to join when you return to the game.', {names = list})
        end
        return ui.t('{names} are joining your party.', {names = list})
    end

    -- True while a companion that joined waits for the others of its burst.
    local function holdingJoined(active, at)
        return #burst.joined > 0 and #active > 0 and burst.joinedAt ~= nil and at - burst.joinedAt < JOIN_HOLD_MS
    end

    -- The progress line keeps naming a held companion that the previous notice
    -- already named, in invitation order, so the text does not change.
    local function withHeld(inflight)
        if #inflight == 0 then return inflight end
        local listed, seen = {}, {}
        for _, entry in ipairs(inflight) do listed[#listed + 1] = entry; seen[entry.name] = true end
        for _, item in ipairs(burst.joined) do
            local gone = burst.gone[item.name]
            if gone and gone.shown and not seen[item.name] then
                seen[item.name] = true
                listed[#listed + 1] = {name = item.name, stage = 'joining', source = gone.source, seq = gone.seq}
            end
        end
        table.sort(listed, function(a, b) return (a.seq or 0) < (b.seq or 0) end)
        return listed
    end

    local function compose(inflight, developer, holding)
        local lines = {}
        if #burst.joined > 0 and not holding then
            local names = uniqueNames(burst.joined)
            local line = #names <= 1 and burst.joined[1].message
                or ui.t('{names} joined your group.', {names = listNames(names)})
            if #names > 1 then
                for _, item in ipairs(burst.joined) do
                    if item.warning then line = line .. ' ' .. item.warning; break end
                end
            end
            lines[#lines + 1] = line
        end
        for index, failure in ipairs(burst.failures) do
            if index > 2 then
                lines[#lines + 1] = ui.t('{count} more companions also failed.', {count = #burst.failures - 2})
                break
            end
            lines[#lines + 1] = failure.message
        end
        local line = progress(holding and withHeld(inflight) or inflight, developer)
        if line then lines[#lines + 1] = line end
        return table.concat(lines, '\n')
    end

    -- Returns nil (nothing to say now) or {message, commit}. The caller invokes
    -- commit() only after the message was really posted.
    function B.take(worldReady)
        worldReady = worldReady == true
        local developer = developerMode()
        local at = now()
        local active = sample(worldReady)
        local inflight = visible(active, at)
        local holding = holdingJoined(active, at)
        local text = compose(inflight, developer, holding)
        if text == '' then
            if #active == 0 then burst = newBurst() end
            return nil
        end
        local core = table.concat({text, tostring(ui.revision()), developer and 'developer' or 'normal'}, '|')
        -- A copy not announced yet, or one whose profile was chosen again (a new
        -- revision), is announced even when its text equals the previous notice.
        local fresh = burst.fresh and not (holding and #burst.failures == 0)
        for _, entry in ipairs(inflight) do if entry.announced ~= entry.revision then fresh = true end end
        if not fresh and core == shownCore and (not worldReady or core == shownGameplayCore) then
            if #active == 0 then burst = newBurst() end
            return nil
        end
        -- The previous notice has not been up long enough: hold this change (a
        -- new failure excepted). A notice hidden by the menu is not "up", so a
        -- change of world state never waits.
        local urgent = false
        for _, failure in ipairs(burst.failures) do if not failure.announced then urgent = true end end
        if not urgent and lastAt and lastWorld == worldReady and at - lastAt < (lastHold or MIN_SHOW_MS) then return nil end
        return {message = text, commit = function()
            local stages = {}
            for _, entry in ipairs(active) do stages[#stages + 1] = tostring(entry.name) .. '=' .. entry.stage end
            note('Notice posted (' .. (worldReady and 'gameplay' or 'menu') .. ', ' .. (lastAt and (math.floor(at - lastAt) .. ' ms after the previous') or 'first')
                .. '): ' .. text:gsub('\n', ' / ') .. (#stages > 0 and (' [' .. table.concat(stages, ', ') .. ']') or ''))
            shownCore, lastAt, lastWorld = core, at, worldReady
            -- A final outcome (joined or failed, nothing else going) stays up longer.
            lastHold = (#active == 0 and (#burst.joined > 0 or #burst.failures > 0)) and FINAL_SHOW_MS or MIN_SHOW_MS
            for _, failure in ipairs(burst.failures) do failure.announced = true end
            if worldReady then shownGameplayCore = core end
            for _, entry in ipairs(inflight) do entry.announced = entry.revision end
            burst.fresh = false
            if #active == 0 then burst = newBurst() end
        end}
    end

    function B.inspect()
        local result = {entries = {}, joined = #burst.joined, failures = #burst.failures}
        for _, entry in ipairs(entries) do
            result.entries[#result.entries + 1] = {id = entry.id, name = entry.name, stage = entry.stage,
                source = entry.source, failed = entry.failed == true}
        end
        return result
    end

    return B
end

function M.new(companions, readiness, options)
    options = options or {}
    local Q = {}
    local owner, sequence, joins, leaves = nil, 0, {}, {}
    local attaching, notices = {}, {}
    -- A dismissal that the game refused. The copy stays in the party, so its
    -- row returns with this reason beside it until the next attempt.
    local dismissErrors = {}
    local feedback = ''
    local stopIntent, tripFeedback = false, nil
    local tripGeneration, tripNotices = nil, {}
    local preparationId, noticeBoard

    local function developerMode()
        if type(options.developerMode) ~= 'function' then return false end
        local ok, enabled = pcall(options.developerMode)
        return ok and enabled == true
    end

    -- The in-menu feedback line always updates. A routine result (a successful
    -- dismissal) is posted as a gameplay notice only in Developer mode.
    -- info ({kind = 'joined' | 'failed', name}) lets the notice board merge an
    -- invitation outcome with the others; a plain notice has no info.
    local function report(message, failed, invitationId, routine, info)
        feedback = message
        if routine and failed ~= true and not developerMode() then return end
        notices[#notices + 1] = {message = message, failed = failed == true, invitationId = invitationId, info = info}
    end

    function Q.bind(identity)
        local changed = readiness and readiness.bind(identity) == true
        if identity ~= owner or changed then
            owner, joins, leaves, feedback = identity, {}, {}, ''
            attaching, notices, dismissErrors = {}, {}, {}
            stopIntent, tripFeedback = false, nil
            tripGeneration, tripNotices = nil, {}
            preparationId = nil
            if noticeBoard then noticeBoard.reset() end
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

    function Q.claimPreparationFailure(id, revision)
        for _, job in ipairs(joins) do
            if job.id == id and (revision == nil or job.revision == revision) then
                if job.failureNotified then return false end
                job.failureNotified = true
                return true
            end
        end
        return false
    end

    local function preparation(job)
        if job.error then return {state = 'error', error = job.error} end
        if not readiness then return {state = 'ready'} end
        local called, state = pcall(readiness.status, job)
        if not called or type(state) ~= 'table' then
            return {state = 'error', error = ui.t('Companion preparation is unavailable.')}
        end
        if state.state ~= 'memory' and state.state ~= 'connecting' and state.state ~= 'ready'
            and state.state ~= 'model-only' and state.state ~= 'error' then
            return {state = 'error', error = ui.t('Companion preparation returned an invalid state.')}
        end
        if state.state == 'error' then job.error = state.error or ui.t('Companion preparation failed.') end
        return state
    end

    function Q.preparationFeedback(id)
        Q.bind(owner)
        -- This reads a pending invitation only. Progress does not flush the
        -- world queue or consume the notices delivered after gameplay resumes.
        for _, job in ipairs(joins) do
            if job.id == (id or preparationId) then
                local status = preparation(job)
                local text = 'Preparing {name}…'
                if status.state == 'connecting' then text = 'Connecting {name}…'
                elseif status.state == 'ready' or status.state == 'model-only' then
                    text = '{name} is ready to join when you return to the game.'
                elseif status.state == 'error' then
                    text = '{name}: preparation failed. Cancel and invite again.'
                end
                return {id = job.id, revision = job.revision, name = job.name, state = status.state,
                    message = ui.t(text, {name = job.name}), failed = status.state == 'error',
                    signature = table.concat({job.id, tostring(job.revision), status.state}, '|')}
            end
        end
        return nil
    end

    function Q.invitationFeedback(id)
        if not id then return nil end
        local pending = Q.preparationFeedback(id)
        if pending then return pending end
        -- A ready invitation can spawn on the first gameplay frame. Report its
        -- current joining stage instead of replaying paused preparation text.
        -- Attachment completion/failure is delivered by the existing notices.
        for serial, job in pairs(attaching) do
            if job.id == id and not leaves[serial] then
                for _, member in ipairs(companions.list()) do
                    if member.serial == serial and member.state == 'spawning' then
                        return {id = job.id, revision = job.revision, name = job.name, state = 'joining',
                            message = ui.t('{name} is joining your party.', {name = job.name}), failed = false,
                            signature = table.concat({job.id, tostring(job.revision), 'joining'}, '|')}
                    end
                end
            end
        end
        return nil
    end

    -- The shared notice board for manager and phone invitations (see M.newBoard).
    function Q.board()
        if not noticeBoard then
            noticeBoard = M.newBoard({feedback = function(id) return Q.invitationFeedback(id) end,
                developerMode = developerMode})
        end
        return noticeBoard
    end

    function Q.list()
        Q.bind(owner)
        local result = {}
        for _, member in ipairs(companions.list()) do
            local item = {}
            for key, value in pairs(member) do item[key] = value end
            item.id = 'live:' .. member.serial
            -- A dismissal is shown at once. The world deletion waits for flush().
            if leaves[member.serial] then item.state = 'leaving' end
            item.dismissError = dismissErrors[member.serial]
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

    function Q.chauffeur()
        -- companions.chauffeurSnapshot copies Lua state only. This function is
        -- safe in the menu's schema and action callbacks.
        local state = companions.chauffeurSnapshot and companions.chauffeurSnapshot() or {active = false, phase = 'idle'}
        state.stopPending = stopIntent
        state.driverSerial = state.offer and state.offer.actor and state.offer.actor.serial
        return state
    end

    function Q.stopTrip()
        if not Q.chauffeur().active then return false, ui.t('There is no companion trip to cancel.') end
        stopIntent = true
        feedback = ui.t('The trip will be stopped when you return to gameplay.')
        return true, feedback
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
        if not owner then return false, ui.t('Load a save before inviting a companion.') end
        local definition = companions.definition(key)
        if not definition then return false, ui.t('That character model is unavailable.') end
        if Q.count() >= 8 then return false, ui.t('There is no room for another companion. Dismiss one first.') end
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
        preparationId = job.id
        local ok, reason = prepare(job)
        if not ok then
            job.preparationError = job.error
            job.failureNotified = true
            report(ui.t('{name} could not prepare: {reason}', {name = job.name, reason = reason}), true, job.id,
                nil, {kind = 'failed', name = job.name})
            return false, feedback, id
        end
        feedback = readiness and ui.t(job.profileKey and 'Preparing {name}…'
            or '{name} is ready to join when you return to the game.', {name = job.name})
            or ui.t('{name} will join when you return to the game.', {name = job.name})
        return true, feedback, id
    end

    function Q.dismiss(id)
        local member = find(id)
        if not member then return false, ui.t('That copy is no longer in your party.') end
        if member.serial then
            local trip = Q.chauffeur()
            if trip.active and trip.driverSerial == member.serial then
                return false, ui.t('Stop the trip and step out before dismissing your driver.')
            end
            leaves[member.serial], dismissErrors[member.serial] = true, nil
            if attaching[member.serial] and readiness then readiness.cancel(attaching[member.serial]) end
            feedback = ui.t('{name} will leave when you return to the game.', {name = member.name})
        else
            for index, job in ipairs(joins) do
                if job.id == id then
                    if readiness then readiness.cancel(job) end
                    if preparationId == id then preparationId = nil end
                    table.remove(joins, index); break
                end
            end
            feedback = ui.t('{name}: invitation cancelled.', {name = member.name})
        end
        return true, feedback
    end

    -- Phone "dismiss this character". A copy belongs to the character it
    -- speaks as; a copy with no conversation profile belongs to its model.
    -- Exactly one copy is chosen, newest first: pending invitations, then
    -- joined copies by serial. Copies already leaving are used only when no
    -- other copy exists (a repeat press is then harmless), and a refused copy
    -- (a chauffeur driver) yields to another copy of the same character.
    -- Returns nil when the character is absent, else accepted, message, id.
    function Q.dismissCharacter(key)
        local ranked = {}
        for _, state in ipairs({'present', 'leaving'}) do
            local members = Q.list()
            for index = #members, 1, -1 do
                local item = members[index]
                if (item.profileKey or item.key) == key and (item.state == 'leaving') == (state == 'leaving') then
                    ranked[#ranked + 1] = item
                end
            end
        end
        local refused
        for _, item in ipairs(ranked) do
            local accepted, message = Q.dismiss(item.id)
            if accepted then return true, message, item.id end
            refused = refused or message
        end
        if refused then return false, refused end
        return nil
    end

    function Q.undoDismiss(id)
        local member = find(id)
        if not member or not member.serial or not leaves[member.serial] then
            return false, ui.t('That dismissal is no longer pending.')
        end
        if Q.count() >= 8 then return false, ui.t('Cancel an invitation first; the party is full.') end
        leaves[member.serial] = nil
        feedback = ui.t('{name} will stay in the party.', {name = member.name})
        return true, feedback
    end

    function Q.assign(id, key, name)
        local member = find(id)
        if not member or member.state == 'leaving' then return false, ui.t('Choose an active or invited copy.') end
        if member.serial then
            -- Conversation identity is Lua data, so it can change while paused.
            local ok, err = companions.setProfile(member.serial, key, name)
            if not ok then return false, err end
            local job = attaching[member.serial]
            if job then
                job.profileKey, job.profileName, job.revision = key, name or job.name, job.revision + 1
                job.error, job.preparationError, job.failureNotified = nil, nil, nil
                local prepared, reason = prepare(job)
                if not prepared then return false, reason end
                if readiness then readiness.spawned(job, member.serial) end
            end
        else
            for _, job in ipairs(joins) do
                if job.id == id then
                    job.profileKey, job.profileName, job.revision = key, name or job.name, job.revision + 1
                    preparationId = job.id
                    job.error, job.preparationError, job.failureNotified = nil, nil, nil
                    local ok, reason = prepare(job)
                    if not ok then
                        feedback = ui.t('{name} could not prepare: {reason}', {name = member.name, reason = reason})
                        return false, feedback
                    end
                    break
                end
            end
        end
        feedback = name and ui.t('{name}: conversation set to {profile}.', {name = member.name, profile = name})
            or ui.t('{name}: conversation profile cleared.', {name = member.name})
        return true, feedback
    end

    function Q.flush()
        Q.bind(owner)
        if not owner then return end
        if stopIntent then
            stopIntent = false
            local called, ok, reason = pcall(companions.cancelChauffeur, 'Trip cancelled from Companion Manager.')
            report(called and ok and ui.t('Stopping the trip. Wait for the car to stop before stepping out.')
                or ui.t(called and reason or 'The driving request could not be cancelled.'), not (called and ok))
        end
        local trip = Q.chauffeur()
        if trip.generation ~= tripGeneration then
            tripGeneration, tripNotices, tripFeedback = trip.generation, {}, nil
        end
        local developer = developerMode()
        local signature = table.concat({trip.phase or '', trip.reason or '', trip.error or '', trip.outcome or '',
            developer and 'developer' or 'normal'}, '|')
        if signature ~= tripFeedback then
            tripFeedback = signature
            local message, failed
            if trip.error then message, failed = ui.t(trip.error), true
            elseif trip.outcome == 'failed' and trip.reason then
                message, failed = ui.t(trip.reason), true
            elseif developer then
                if trip.phase == 'driving' then message = ui.t('Your companion is driving to the selected waypoint.')
                elseif trip.phase == 'waiting-for-player' then
                    message = ui.t('Your companion is ready. Get in the passenger seat to start the trip.')
                elseif trip.phase == 'waiting-for-player-exit' then
                    message = ui.t('The car has stopped. Step out so your companion can leave the driver seat.')
                elseif trip.reason then message = ui.t(trip.reason) end
            end
            -- Saved Developer mode controls routine instructions only. Include
            -- the live choice in the signature so turning it on mid-trip shows
            -- the current instruction once; never replay already shown text.
            -- Native command polls can alternate an error and a stable stop
            -- reason. A signature change is not a new actionable message.
            -- Keep one notice per text per actual trip; a different later
            -- instruction or a new generation still receives its own notice.
            if message and not tripNotices[message] then
                tripNotices[message] = true
                report(message, failed)
            end
        end
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
                report(ui.t('{name} joined your group.', {name = member.name}) .. (job.warning and (' ' .. job.warning) or ''),
                    nil, nil, nil, {kind = 'joined', name = member.name, warning = job.warning})
                attaching[serial] = nil
            elseif not member or member.state == 'failed' or member.state == 'missing' or member.state == 'dead' then
                if readiness then readiness.cancel(job) end
                report(ui.t('{name} could not join: {reason}', {name = job.name,
                    reason = member and ui.t(member.error) or ui.t(member and member.state == 'dead'
                        and 'The character died before joining.' or 'The character was removed before joining.')}), true,
                    nil, nil, {kind = 'failed', name = job.name})
                attaching[serial] = nil
            end
        end
        -- Deletions run first; a failed deletion still occupies its real slot.
        for _, member in ipairs(companions.list()) do
            if leaves[member.serial] then
                local called, ok, err = pcall(companions.dismiss, member.serial)
                leaves[member.serial] = nil
                -- The row was hidden optimistically. A refused deletion keeps the
                -- real slot, so the copy is listed again with the reason.
                dismissErrors[member.serial] = not (called and ok)
                    and tostring((called and err) or (not called and ok) or ui.t('The copy could not be dismissed.')) or nil
                report(called and ok and ui.t('{name} dismissed.', {name = member.name})
                    or (member.name .. ': ' .. tostring(called and err or ok)), not (called and ok), nil, true)
            end
        end
        local remaining = {}
        for _, job in ipairs(joins) do
            local status = preparation(job)
            if not job.error and (status.state == 'ready' or status.state == 'model-only') then
                local called, serial, err, deferred = pcall(companions.spawn, job.key, job)
                if called and deferred == true then
                    -- A shared frame budget is scheduling, not an invitation
                    -- failure. Keep its prepared reservation and retry later.
                    remaining[#remaining + 1] = job
                elseif called and serial then
                    local assigned, assignmentError = companions.setProfile(serial, job.profileKey, job.profileName)
                    job.warning = not assigned and tostring(assignmentError) or nil
                    attaching[serial] = job
                    if readiness then readiness.spawned(job, serial) end
                    feedback = assigned and ui.t('{name} is joining your party.', {name = job.name})
                        or (job.name .. ': ' .. tostring(assignmentError))
                else
                    job.error = tostring(called and err or serial)
                    if readiness then readiness.cancel(job) end
                    report(ui.t('{name} could not join: {reason}', {name = job.name, reason = ui.t(job.error)}), true, job.id,
                        nil, {kind = 'failed', name = job.name})
                    remaining[#remaining + 1] = job
                end
            else
                if status.state == 'error' and Q.claimPreparationFailure(job.id, job.revision) then
                    job.preparationError = status.error
                    report(ui.t('{name} could not prepare: {reason}', {name = job.name, reason = tostring(status.error)}), true, job.id,
                        nil, {kind = 'failed', name = job.name})
                end
                remaining[#remaining + 1] = job
            end
        end
        joins = remaining
    end

    return Q
end

return M
