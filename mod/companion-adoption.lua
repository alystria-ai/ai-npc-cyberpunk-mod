-- World characters who join V, and party members who leave (docs/WORLD_COMPANIONS.md).
--
-- A world character asked to follow is never given a follower role. It joins
-- through the ordinary party queue as a managed copy (same record, current
-- appearance, placed where it stood); the moment that copy is attached, the
-- original is hidden (runtime visibility only, nothing persists). When the copy
-- leaves the party, the original is shown again once V is far away or looking
-- elsewhere, and carries on with its own routine. Quest, scene, police, vendor,
-- hostile, mounted or already-directed characters are refused.
--
-- Both actions run after the reply that requested them has been heard: the
-- copy appears once the character has answered, and a companion leaves after
-- its goodbye. The model decides that V meant it (gameplay-actions.lua); this
-- module only re-checks the game state and performs it.
local ui = (convaiUiLocale or dofile('ui-locale.lua'))
local M = {}

M.CONFIG = {
    replyWait = 30,       -- seconds an action waits for its reply to finish playing
    nearby = 15,          -- metres: the original must still be this close when the copy is placed
    crowdRelease = 50,    -- metres: a hidden crowd original (pooled by the game) is shown again past this
    restoreDistance = 60, -- metres: a former member's original is shown again past this ...
    restoreAngle = 70,    -- ... or once it is this many degrees away from where V is looking ...
    restoreWait = 20,     -- ... or after this many seconds
}

local function dist(a, b)
    if not a or not b then return math.huge end
    return math.sqrt((a.x - b.x)^2 + (a.y - b.y)^2 + (a.z - b.z)^2)
end

-- Native reads and the one native write (visibility). Every call is guarded by
-- the caller; tests replace this table.
function M.nativeAdapter()
    local N = {}
    function N.entity(npc) return tostring(npc:GetEntityID().hash) end
    function N.alive(npc) return npc:IsAttached() and not npc:IsDeadNoStatPool() end
    function N.position(npc) local p = npc:GetWorldPosition(); return {x = p.x, y = p.y, z = p.z} end
    function N.orientation(npc) return npc:GetWorldOrientation() end
    function N.appearance(npc)
        local name = NameToString(npc:GetCurrentAppearanceName())
        return name ~= '' and name ~= 'None' and name or nil
    end
    function N.record(npc) return npc:GetRecordID() end
    function N.crowd(npc) return npc:IsCrowd() == true end
    function N.playerPosition(player) local p = player:GetWorldPosition(); return {x = p.x, y = p.y, z = p.z} end
    function N.cameraForward(player)
        local _, forward = Game.GetTargetingSystem():GetCrosshairData(player)
        return forward and {x = forward.x, y = forward.y, z = forward.z} or nil
    end
    function N.setVisible(npc, visible)
        -- The same event the phantom controller uses to hide or show a whole
        -- entity (companion-appearance.lua). It is runtime state only.
        local event = NewObject('enteventsSetVisibility')
        event.visible = visible == true
        event.source = Enum.new('entVisibilityParamSource', 'PhantomEntitySystem')
        npc:QueueEvent(event)
    end
    -- Why this character must not leave with V, or nil when it may. An
    -- unreadable signal counts as a refusal: adoption needs positive evidence.
    function N.refusal(npc, player)
        local function read(fn)
            local ok, value = pcall(fn)
            if not ok then return nil end
            return value
        end
        if read(function() return npc:IsA('NPCPuppet') end) ~= true then return 'busy' end
        if read(function() return NPCPuppet.IsInCombat(npc) or player:IsInCombat() end) ~= false then return 'combat' end
        if read(function() return npc:IsPrevention() or npc:IsCharacterPolice() end) ~= false then return 'police' end
        -- A quest-marked actor, or one whose AI a quest or scene drives.
        if read(function() return npc:IsQuest() or not npc:IsOnAutonomousAI() end) ~= false then return 'quest' end
        if read(function()
            local scenes = Game.GetSceneSystem():GetScriptInterface()
            local id = npc:GetEntityID()
            return scenes:IsEntityInScene(id) or scenes:IsEntityInDialogue(id)
        end) ~= false then return 'scene' end
        if read(function() return npc:IsVendor() end) ~= false then return 'working' end
        if read(function() return npc:IsHostile() end) ~= false then return 'hostile' end
        if read(function() return npc:IsCharacterChildren() end) ~= false then return 'busy' end
        -- Already a vanilla companion, or given any AI role by its owner.
        if read(function()
            if npc:IsPlayerCompanion() then return true end
            local ai = npc:GetAIControllerComponent()
            if not ai then return true end
            local role = ai:GetAIRole()
            return role ~= nil and not role:IsA('AINoRole')
        end) ~= false then return 'busy' end
        if read(function()
            local info = Game.GetMountingFacility():GetMountingInfoSingleWithObjects(npc)
            local parent = info and info.parentId
            return parent ~= nil and parent.hash ~= nil and tostring(parent.hash):match('^0+[uUlL]*$') == nil
        end) ~= false then return 'vehicle' end
        return nil
    end
    return N
end

-- options: companions, party() -> the party queue, player(), busy(requestId,
-- groupId) -> true while that reply is still being delivered, named(key) ->
-- true for one specific character (duplicates refused), groupEntities(context)
-- -> entity ids in that group round, promote(key), log(line), native.
function M.new(options)
    options = options or {}
    local cfg = {}
    for key, value in pairs(M.CONFIG) do cfg[key] = options[key] or value end
    local companions = options.companions
    local native = options.native or M.nativeAdapter()
    local A = {}
    local clock, sequence = 0, 0
    local records, departures, offered = {}, {}, {}

    local function log(line) if type(options.log) == 'function' then pcall(options.log, line) end end
    local function queue() return type(options.party) == 'function' and options.party() or nil end
    local function player() return type(options.player) == 'function' and options.player() or nil end
    local function guard(fn, ...)
        local ok, value = pcall(fn, ...)
        if ok then return value end
        return nil
    end
    local function alive(npc) return npc ~= nil and guard(native.alive, npc) == true end
    local function busy(requestId, groupId)
        if type(options.busy) ~= 'function' then return false end
        local ok, value = pcall(options.busy, requestId, groupId)
        return ok and value == true
    end
    local function named(key)
        if type(options.named) ~= 'function' then return true end
        local ok, value = pcall(options.named, key)
        return not ok or value ~= false
    end
    local function partyRows()
        local ok, rows = pcall(companions.list)
        return ok and type(rows) == 'table' and rows or {}
    end
    local function active(record) return record.state == 'preparing' or record.state == 'joined' end

    -- The reason a follow is refused, or nil. own: the adoption being re-checked.
    local function refusal(entity, npc, profileKey, own)
        local current = player()
        if not current or not alive(npc) or guard(native.entity, npc) ~= entity then return 'busy' end
        for id, record in pairs(records) do
            if record ~= own and active(record) and (id == entity or (named(profileKey) and record.profileKey == profileKey)) then
                return 'already-here'
            end
        end
        if not own then
            if named(profileKey) then
                for _, key in ipairs(guard(companions.connectionProfiles) or {}) do
                    if key == profileKey then return 'already-here' end
                end
            end
            local party = queue()
            local count = party and guard(party.count)
            if type(count) == 'number' and count >= 8 then return 'party-full' end
        end
        local ok, reason = pcall(native.refusal, npc, current)
        if not ok then return 'busy' end
        return reason
    end

    local function refusalMessage(reason, name)
        if reason == 'party-full' then return ui.t('There is no room for another companion. Dismiss one first.') end
        if reason == 'already-here' then return ui.t('{name} is already with you.', {name = name}) end
        if reason == 'gone' then return ui.t('{name} is no longer nearby.', {name = name}) end
        return ui.t('{name} can\'t come along right now.', {name = name})
    end

    -- Follow offer for a conversation with a world character (not a party
    -- member). Available, or unavailable with one reason code, or nil.
    function A.offer(entity, npc, profileKey, name)
        if type(entity) ~= 'string' or type(profileKey) ~= 'string' or not npc then return nil end
        if guard(companions.owns, npc) or guard(companions.partyMember, entity) then return nil end
        local reason = refusal(entity, npc, profileKey)
        if reason then return {available = false, reason = reason} end
        local label = type(name) == 'string' and name ~= '' and name:sub(1, 120) or profileKey
        -- One conversation leases one offer at a time; only the latest is kept.
        offered = {[entity] = {npc = npc, profileKey = profileKey, name = label}}
        return {available = true, actor = {id = entity, key = profileKey}, name = label}
    end

    -- Leave offer: the addressed party member, or in a group round's first
    -- turn every party member of that round. Members already leaving or
    -- driving V are left out.
    function A.leaveOffer(entity, context)
        if type(entity) ~= 'string' or type(context) ~= 'table' or type(context.profileKey) ~= 'string' then return nil end
        local leaving = {}
        for _, departure in ipairs(departures) do
            for _, serial in ipairs(departure.serials) do leaving[serial] = true end
        end
        local entities = {entity}
        if context.group then
            local ok, list = pcall(options.groupEntities, context)
            entities = ok and type(list) == 'table' and list or {}
        end
        local members, seen = {}, {}
        for _, id in ipairs(entities) do
            local member = type(id) == 'string' and not seen[id] and guard(companions.partyMember, id) or nil
            seen[id] = true
            if member and not member.driving and not leaving[member.serial] and #members < 3 then
                members[#members + 1] = {serial = member.serial, id = member.id, key = member.key,
                    name = tostring(member.name or member.key):sub(1, 120)}
            end
        end
        if #members == 0 then return nil end
        return {available = true, actor = {id = entity, key = context.profileKey}, members = members}
    end

    local function recordFor(key)
        for _, record in pairs(records) do if record.key == key then return record end end
    end

    -- The model chose to follow V. Re-check everything and reserve a party
    -- place; the copy is placed after the reply (the job's gate).
    function A.queueFollow(offer, entity, requestId)
        local seen = offered[entity]
        local name = seen and seen.name or (type(offer) == 'table' and offer.name) or ''
        if type(offer) ~= 'table' or type(offer.actor) ~= 'table' or offer.actor.id ~= entity or not seen
            or seen.profileKey ~= offer.actor.key then
            return false, refusalMessage('gone', name)
        end
        local npc = seen.npc
        local reason = refusal(entity, npc, seen.profileKey)
        if reason then return false, refusalMessage(reason, name) end
        local party = queue()
        if not party then return false, refusalMessage('busy', name) end
        local recordID = guard(native.record, npc)
        if not recordID then return false, refusalMessage('busy', name) end
        sequence = sequence + 1
        local key = 'world-' .. entity:gsub('[^%w]', '') .. '-' .. sequence
        local registered, why = companions.registerDefinition(key, {recordID = recordID, name = name,
            profileKey = seen.profileKey, profileName = name})
        if not registered then return false, tostring(why) end
        -- Generic people (residents, archetypes) have no per-character memory to
        -- prepare and no connection without a body: they join as a model and
        -- get their conversation profile when the copy is attached.
        local modelOnly = not named(seen.profileKey)
        local record = {entity = entity, npc = npc, key = key, profileKey = seen.profileKey, name = name,
            requestId = requestId, state = 'preparing', since = clock, modelOnly = modelOnly,
            crowd = guard(native.crowd, npc) == true, home = guard(native.position, npc)}
        local adoption = {entity = entity}
        record.adoption = adoption
        local gate = function()
            if record.state ~= 'preparing' then return nil, refusalMessage('gone', name) end
            if busy(requestId) and clock - record.since < cfg.replyWait then return false end
            local current = player()
            local at = alive(npc) and guard(native.position, npc)
            if not current or not at or dist(at, guard(native.playerPosition, current)) > cfg.nearby then
                record.state = 'ended'
                return nil, refusalMessage('gone', name)
            end
            local refused = refusal(entity, npc, record.profileKey, record)
            if refused then record.state = 'ended'; return nil, refusalMessage(refused, name) end
            adoption.position = at
            adoption.orientation = guard(native.orientation, npc)
            adoption.appearance = guard(native.appearance, npc)
            record.home = at
            return true
        end
        records[entity] = record
        local ok, accepted, message, id = pcall(party.invite, key, {adoption = adoption, gate = gate, modelOnly = modelOnly})
        if not ok or not accepted then
            records[entity] = nil
            return false, tostring(ok and message or accepted)
        end
        record.jobId = id
        offered[entity] = nil
        log('Adoption queued: ' .. seen.profileKey .. ' actor=' .. entity)
        return true, ui.t('{name} is coming with you.', {name = name})
    end

    -- The model chose to send a companion (or everyone offered) away. The
    -- dismissal itself is the Current party Dismiss, after the goodbye.
    function A.queueLeave(target, offer, entity, requestId, groupId)
        if type(offer) ~= 'table' or type(offer.members) ~= 'table' then return false, ui.t('That action is not available.') end
        local serials, names = {}, {}
        for _, member in ipairs(offer.members) do
            if target == 'all' or member.id == target then
                local current = guard(companions.partyMember, member.id)
                if current and current.serial == member.serial and current.key == member.key and not current.driving then
                    serials[#serials + 1] = member.serial
                    names[#names + 1] = member.name
                end
            end
        end
        if #serials == 0 then return false, ui.t('That companion is no longer in your party.') end
        departures[#departures + 1] = {serials = serials, requestId = requestId, groupId = groupId, at = clock}
        log('Departure queued: ' .. table.concat(names, ', '))
        return true, ui.t('{name} is leaving your party.', {name = table.concat(names, ', ')})
    end

    function A.hidden(value)
        if value == nil or next(records) == nil then return false end
        local entity = type(value) == 'string' and value or guard(native.entity, value)
        local record = entity and records[entity]
        return record ~= nil and record.hidden == true
    end

    local function show(record)
        if record.hidden and alive(record.npc) then
            local ok = pcall(native.setVisible, record.npc, true)
            log('Adoption original ' .. (ok and 'shown again: ' or 'could not be shown again: ') .. record.entity)
        end
        record.hidden = false
    end

    local function inView(record, current)
        local at, from = guard(native.position, record.npc), guard(native.playerPosition, current)
        if not at or not from then return false end
        if dist(at, from) > cfg.restoreDistance then return false end
        local forward = guard(native.cameraForward, current)
        if not forward then return true end
        local dx, dy = at.x - from.x, at.y - from.y
        local length, fl = math.sqrt(dx * dx + dy * dy), math.sqrt(forward.x^2 + forward.y^2)
        if length < 0.5 or fl < 0.01 then return true end
        local cosine = math.max(-1, math.min(1, (dx * forward.x + dy * forward.y) / (length * fl)))
        return math.deg(math.acos(cosine)) <= cfg.restoreAngle
    end

    function A.update(dt)
        clock = clock + (tonumber(dt) or 0)
        if next(records) == nil and #departures == 0 then return end
        local current = player()
        local rows = next(records) ~= nil and partyRows() or {}
        local party = queue()
        local pendingJobs, preparing = {}, false
        for _, record in pairs(records) do if record.state == 'preparing' then preparing = true end end
        if party and preparing then
            for _, item in ipairs(guard(party.list) or {}) do
                if not item.serial then pendingJobs[item.key] = item end
            end
        end
        for entity, record in pairs(records) do
            local row
            for _, item in ipairs(rows) do if item.key == record.key then row = item end end
            if record.npc and not alive(record.npc) then record.npc, record.hidden = nil, false end
            if record.state == 'preparing' then
                if row and row.state == 'ready' then
                    record.state, record.serial = 'joined', row.serial
                    if record.modelOnly then pcall(companions.setProfile, row.serial, record.profileKey, record.name) end
                    if record.npc and pcall(native.setVisible, record.npc, false) then record.hidden = true end
                    if type(options.promote) == 'function' then pcall(options.promote, record.profileKey) end
                    log('Adoption joined: ' .. record.profileKey .. ' actor=' .. entity .. ' copy=' .. tostring(row.serial))
                elseif row and (row.state == 'failed' or row.state == 'dead' or row.state == 'missing') then
                    record.state, record.endedAt = 'ended', clock
                elseif not row and not pendingJobs[record.key] then
                    record.state, record.endedAt = 'ended', clock
                end
            elseif record.state == 'joined' then
                if not row or row.state == 'failed' or row.state == 'dead' or row.state == 'missing' then
                    record.state, record.endedAt = 'ended', clock
                    log('Adoption ended: ' .. record.profileKey .. ' actor=' .. entity)
                end
            end
            -- The game pools crowd people; never leave one hidden once V has moved on.
            if record.hidden and record.crowd and current and record.npc
                and dist(guard(native.position, record.npc), guard(native.playerPosition, current)) > cfg.crowdRelease then
                show(record)
            end
            if record.state == 'ended' then
                record.endedAt = record.endedAt or clock
                if not record.hidden or not record.npc then records[entity] = nil
                elseif not current or not inView(record, current) or clock - record.endedAt >= cfg.restoreWait then
                    show(record); records[entity] = nil
                end
            end
        end
        for index = #departures, 1, -1 do
            local departure = departures[index]
            if not busy(departure.requestId, departure.groupId) or clock - departure.at >= cfg.replyWait then
                table.remove(departures, index)
                for _, serial in ipairs(departure.serials) do
                    local ok, accepted, message = false, false, nil
                    if party then ok, accepted, message = pcall(party.dismiss, 'live:' .. serial) end
                    log('Departure ' .. ((ok and accepted) and 'sent' or 'refused') .. ' for copy ' .. serial
                        .. ((ok and accepted) and '' or (': ' .. tostring(message or accepted))))
                end
            end
        end
    end

    -- World teardown: copies are nonpersistent and visibility is runtime state,
    -- so a load needs no native call. Fast travel keeps the party and records.
    function A.abandon(preserveTransit)
        if preserveTransit then return end
        records, departures, offered = {}, {}, {}
    end

    function A.inspect()
        local rows = {}
        for entity, record in pairs(records) do
            rows[#rows + 1] = {entity = entity, key = record.key, profileKey = record.profileKey, state = record.state,
                hidden = record.hidden == true, crowd = record.crowd, serial = record.serial}
        end
        return {adoptions = rows, departures = #departures, clock = clock}
    end

    return A
end

return M
