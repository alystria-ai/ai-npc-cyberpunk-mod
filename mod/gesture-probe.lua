local convaiPlayer = convaiPlayer or function() return Game.GetPlayer() end
-- Stage 0 development probe for companion body gestures (docs/COMPANION_GESTURES.md).
-- Inert until a request arrives in runtime/gesture-probe-request.txt:
--   line 1: a fresh nonce, line 2: a command (see COMMANDS below).
-- Results go to runtime/gesture-probe-response.txt (nonce + JSON) and a JSON-lines
-- trace in runtime/gesture-probe.log. The companions loop calls observe() for
-- each settled copy and tick() once per update; while a copy is in a probe
-- workspot, movement waits (observe returns true) exactly like the holster
-- handoff. Leaving the settled stance or combat ends the workspot (guard).
local M = convaiGestureProbe or {}
-- The gesture catalog (1.4 MB of generated Lua, about 1.2 MB of tables in the Lua heap) is read on the probe's first
-- command, not when the file loads: an idle probe used to hold its own whole copy for the session beside the gesture
-- controller's. A 'reload' runs this file again, so the next command reads the catalog afresh, as before.
local catalogValue
local function catalogData()
    if catalogValue then return catalogValue end
    local catalog = dofile('gesture-catalog.lua')
    -- Catalog v1 (one hands-at-sides family) or v2 (stance families + characters).
    if not catalog.families then
        catalog = {version = 1, device = catalog.device, idleComponents = catalog.idleComponents, characters = {},
            families = {on_sides = {component = catalog.component, idle = catalog.idle, clips = catalog.clips, rigs = catalog.rigs}}}
    end
    catalogValue = catalog
    return catalog
end
local TAG = 'CyberpunkConvaiGestureDevice'
local REQUEST, RESPONSE, LOG = 'runtime/gesture-probe-request.txt', 'runtime/gesture-probe-response.txt', 'runtime/gesture-probe.log'
local HOLDING = {suspending=true, spawning=true, starting=true, active=true, exiting=true, stopping=true}

M.states = M.states or {}
M.clock, M.tickCount, M.pollAt = M.clock or 0, M.tickCount or 0, M.pollAt or 0
M.guard = M.guard ~= false
M.lastNonce = M.lastNonce

-- Rig and signature idle per character record (body rigs verified in the
-- extracted entities; docs/COMPANION_GESTURES.md).
local rigByRecord = {
    ['Character.Judy'] = 'woman_base', ['Character.Panam'] = 'woman_base',
    ['Character.Rogue'] = 'woman_base', ['Character.Misty'] = 'woman_base',
    ['Character.Silverhand'] = 'man_base', ['CyberpunkConvai.JohnnyCompanion'] = 'man_base',
    ['Character.Kerry'] = 'man_base', ['Character.Victor_Vector'] = 'man_base', ['Character.Takemura'] = 'man_base',
    ['Character.Jackie'] = 'man_big', ['Character.Sobchak'] = 'man_big',
}
local idleByRecord = {
    ['Character.Judy'] = 'judy', ['Character.Panam'] = 'panam', ['Character.Silverhand'] = 'johnny',
    ['CyberpunkConvai.JohnnyCompanion'] = 'johnny', ['Character.Kerry'] = 'kerry',
    ['Character.Takemura'] = 'takemura', ['Character.Jackie'] = 'jackie',
}

local function now() return M.clock end
local function encode(value)
    local ok, text = pcall(json.encode, value)
    return ok and text or ('{"encodeError":' .. string.format('%q', tostring(text)) .. '}')
end
local function log(kind, fields)
    fields = fields or {}
    fields.kind, fields.at, fields.wall = kind, math.floor(now() * 1000) / 1000, os.time()
    local file = io.open(LOG, 'a')
    if file then file:write(encode(fields), '\n'); file:close() end
end
local function position(npc)
    local ok, p = pcall(function() return npc:GetWorldPosition() end)
    if not ok or not p then return nil end
    return {x = math.floor(p.x * 100) / 100, y = math.floor(p.y * 100) / 100, z = math.floor(p.z * 100) / 100}
end
local function distance(a, b)
    if not a or not b then return nil end
    return math.floor(math.sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2) * 100) / 100
end
local function workspots() return Game.GetWorkspotSystem() end
local function inWorkspot(npc)
    local ok, value = pcall(function() return workspots():IsActorInWorkspot(npc) end)
    if not ok then return 'error:' .. tostring(value) end
    return value
end
local function character(entry)
    local known = catalogData().characters[entry.record]
    if known then return known end
    return {rig = rigByRecord[entry.record] or 'unknown', idle = idleByRecord[entry.record], key = idleByRecord[entry.record], talk = 'on_sides'}
end
local function rigOf(entry) return character(entry).rig end
local function familyOf(s) return catalogData().families[s.familyKey or 'on_sides'] or catalogData().families.on_sides end
local function clipsFor(s)
    local list, family, key = {}, familyOf(s), s.characterKey
    for index, clip in ipairs(family.clips) do
        if clip.perRig[s.rig] and (clip.character == nil or clip.character == key) then
            list[#list + 1] = {index = index, clip = clip, duration = clip.perRig[s.rig].duration}
        end
    end
    return list
end
local function findClip(s, token)
    local number = tonumber(token)
    local family = familyOf(s)
    if token == 'idle' then return {idle = true, clip = {name = family.idle.name}, duration = 0} end
    for _, item in ipairs(clipsFor(s)) do
        if item.index == number or item.clip.name == token or item.clip.name:find(token, 1, true) then return item end
    end
    -- Explicit request for a clip this rig lacks (T-pose/skip test), any family.
    for _, other in pairs(catalogData().families) do
        for index, clip in ipairs(other.clips) do
            if clip.name == token or clip.name:find(token, 1, true) then
                return {index = index, clip = clip, duration = 3, missing = true}
            end
        end
    end
    return nil
end

-- Request plumbing ---------------------------------------------------------
local function respond(nonce, ok, result)
    local file = io.open(RESPONSE, 'wb')
    if file then file:write(nonce, '\n', encode({ok = ok, result = result})); file:close() end
    log('response', {nonce = nonce, ok = ok, result = result})
end
local function split(text)
    local words = {}
    for word in tostring(text or ''):gmatch('%S+') do words[#words + 1] = word end
    return words
end
local function option(words, key, fallback)
    for _, word in ipairs(words) do
        local value = word:match('^' .. key .. '=(.+)$')
        if value then return value end
    end
    return fallback
end

-- Target resolution against the ready rows given to tick().
local function targets(token)
    local rows = {}
    for _, row in ipairs(M.rows or {}) do
        local entry = row.entry
        local name = string.lower(tostring(entry.name or '') .. ' ' .. tostring(entry.key or '') .. ' ' .. tostring(entry.record or ''))
        if token == 'all' or tostring(entry.serial) == token or name:find(string.lower(token or '?'), 1, true) then
            rows[#rows + 1] = row
        end
    end
    return rows
end
local function stateFor(entry)
    local s = M.states[entry.serial]
    if not s then
        s = {serial = entry.serial, phase = 'off', events = 0}
        M.states[entry.serial] = s
    end
    s.entry, s.name, s.record, s.rig = entry, entry.name, entry.record, rigOf(entry)
    s.characterKey = character(entry).key
    return s
end

-- Device entity ------------------------------------------------------------
local function deleteDevice(s)
    if not s.deviceID then return end
    local ok, err = pcall(function()
        local system = Game.GetDynamicEntitySystem()
        if system:IsManaged(s.deviceID) and system:IsTagged(s.deviceID, CName.new(TAG)) then system:DeleteEntity(s.deviceID) end
    end)
    if not ok then log('device-delete-error', {serial = s.serial, error = tostring(err)}) end
    s.deviceID, s.device = nil, nil
end
local function spawnDevice(s, npc)
    local system = Game.GetDynamicEntitySystem()
    local spec = NewObject('DynamicEntitySpec')
    local assigned = pcall(function() spec.templatePath = catalogData().device end)
    if not assigned then
        assigned = pcall(function() spec.templatePath = ResRef.FromString(catalogData().device) end)
    end
    if not assigned then error('Could not assign the device template path') end
    spec.position = npc:GetWorldPosition()
    spec.orientation = npc:GetWorldOrientation()
    spec.persistState, spec.persistSpawn = false, false
    spec.alwaysSpawned, spec.spawnInView, spec.active = true, true, true
    spec.tags = {CName.new(TAG)}
    local id = system:CreateEntity(spec)
    if not id or tostring(id.hash):match('^0+[uUlL]*$') then error('Device entity was not created') end
    s.deviceID, s.deviceRequestedAt = id, now()
end

-- Native workspot calls ----------------------------------------------------
local function attempt(label, calls)
    local errors = {}
    for index, call in ipairs(calls) do
        local ok, result = pcall(call)
        if ok then return true, result, index, errors end
        errors[#errors + 1] = tostring(result)
    end
    log('native-failed', {call = label, errors = errors})
    return false, nil, nil, errors
end
-- Native signatures (sigs, 2.31): PlayInDevice(device, actor, workspotStateFlavourName,
-- actorDataCompName, deviceDataCompName, syncSlotName, slideTime, slideBehaviour
-- gameWorkspotSlidingBehaviour, callbackEventRecipient); PlayInDeviceSimple(device, actor,
-- allowCameraMov, actorDataCompName, deviceDataCompName, syncSlotName, slideTime,
-- slideBehaviour, callback); PlayNpcInWorkspot(npc, master, referenceEntity,
-- actorDataCompName, syncSlotName, slideTime, syncOffsetSourceCompName).
local function slideEnum(token)
    local number = tonumber(token)
    local name = ({dont = 'DontPlayAtResourcePosition', resource = 'PlayAtResourcePosition'})[token] or token
    for _, typeName in ipairs({'gameWorkspotSlidingBehaviour', 'WorkspotSlidingBehaviour'}) do
        local ok, value = pcall(function() return Enum.new(typeName, number or name) end)
        if ok and value ~= nil then return value end
    end
    return number or 1
end
local function play(s, npc)
    local ws, device, component, none = workspots(), s.device, CName.new(s.component), CName.new('None')
    local sliding, slideTime = slideEnum(s.slide or 'dont'), tonumber(s.slideTime) or 0
    local api = s.api
    local calls = {}
    if api == 'device' or api == 'auto' then
        calls[#calls + 1] = function() return ws:PlayInDevice(device, npc, none, component, none, none, slideTime, sliding, nil) end
        calls[#calls + 1] = function() return ws:PlayInDevice(device, npc, none, component, none, none, slideTime, sliding) end
    end
    if api == 'simple' or api == 'auto' then
        calls[#calls + 1] = function() return ws:PlayInDeviceSimple(device, npc, false, component, none, none, slideTime, sliding, nil) end
    end
    if api == 'npc' or api == 'auto' then
        calls[#calls + 1] = function() return ws:PlayNpcInWorkspot(npc, convaiPlayer(), device, component, none, slideTime, none) end
    end
    local ok, result, index, errors = attempt('play-' .. api, calls)
    log('play', {serial = s.serial, api = api, ok = ok, variant = index, result = tostring(result), errors = errors,
        component = s.component, slide = tostring(sliding), slideTime = slideTime, position = position(npc)})
    return ok
end
local function jump(s, npc, item, instant)
    local ws = workspots()
    local ok, result, index, errors
    if item.byId then
        ok, result, index, errors = attempt('jump-id', {function()
            return ws:SendJumpCommandEnt(npc, item.clip.clipId, instant == true)
        end})
    else
        ok, result, index, errors = attempt('jump', {function() return ws:SendJumpToAnimEnt(npc, CName.new(item.clip.name), instant == true) end})
    end
    log('jump', {serial = s.serial, clip = item.clip.name, byId = item.byId == true, missingOnRig = item.missing == true,
        instant = instant == true, ok = ok, result = tostring(result), errors = errors})
    return ok
end
local function exitWorkspot(s, npc, mode)
    local ws = workspots()
    -- SendFastExitSignal(actor, dirLS, stayInWorkspotIfFailed, playSlowExitIfFailed, instant, tryBlendToWalk)
    local calls = mode == 'instant' and {function() return ws:SendFastExitSignal(npc, Vector3.new(0, 0, 0), false, true, true, false) end,
            function() return ws:StopInDevice(npc, Vector4.new(0, 0, 0, 0), Quaternion.new(0, 0, 0, 1)) end,
            function() return ws:SendFastExitSignal(npc) end}
        or mode == 'slow' and {function() return ws:SendSlowExitSignal(npc, CName.new('None'), true) end,
            function() return ws:SendSlowExitSignal(npc) end}
        or s.exitArgs == 'full' and {function() return ws:SendFastExitSignal(npc, Vector3.new(0, 0, 0), false, true, false, true) end,
            function() return ws:SendFastExitSignal(npc) end}
        -- Native defaults: the only exit observed to leave the AI healthy (Oct 6).
        or {function() return ws:SendFastExitSignal(npc) end}
    local ok, result, _, errors = attempt('exit-' .. mode, calls)
    log('exit', {serial = s.serial, mode = mode, ok = ok, result = tostring(result), errors = errors})
    return ok
end
local function stopWorkspot(s, npc, mode)
    local ws = workspots()
    local function inDevice()
        return ws:StopInDevice(npc, Vector4.new(0, 0, 0, 0), Quaternion.new(0, 0, 0, 1))
    end
    local calls = mode == 'device' and {inDevice, function() return ws:StopInDevice(npc) end}
        or {function() return ws:StopNpcInWorkspot(npc) end, inDevice}
    local ok, result, index, errors = attempt('stop-' .. mode, calls)
    log('stop', {serial = s.serial, mode = mode, ok = ok, variant = index, result = tostring(result), errors = errors})
    return ok
end

-- AI recovery ----------------------------------------------------------------
-- The puppet-state flags native AI checks before running commands
-- (aiAutonomousConditions.script:90, NPCPuppet.script:4103).
local function aiFlags(npc)
    local flags = {}
    pcall(function()
        local defs, board = Game.GetAllBlackboardDefs().PuppetState, npc:GetPuppetStateBlackboard()
        for _, name in ipairs({'WorkspotAnimationInProgress', 'InPendingBehavior', 'SlotAnimationInProgress'}) do
            local ok, value = pcall(function() return board:GetBool(defs[name]) end)
            if ok then flags[name] = value else flags[name] = 'error:' .. tostring(value) end
        end
    end)
    return flags
end
local actuator
local function unstick(s, level)
    local entry, npc = s.entry, s.entry.npc
    local before = {flags = aiFlags(npc), inWorkspot = inWorkspot(npc),
        command = entry.motor and entry.motor.feedback and entry.motor.feedback.state}
    local steps = {}
    local function step(name, fn) local ok, err = pcall(fn); steps[#steps + 1] = {step = name, ok = ok, error = not ok and tostring(err) or nil} end
    step('StopInDevice', function()
        workspots():StopInDevice(npc, Vector4.new(0, 0, 0, 0), Quaternion.new(0, 0, 0, 1))
    end)
    step('clear-flags', function()
        local defs, board = Game.GetAllBlackboardDefs().PuppetState, npc:GetPuppetStateBlackboard()
        if board:GetBool(defs.WorkspotAnimationInProgress) then board:SetBool(defs.WorkspotAnimationInProgress, false) end
        if board:GetBool(defs.InPendingBehavior) then board:SetBool(defs.InPendingBehavior, false) end
    end)
    step('release-command', function()
        actuator = actuator or dofile('companion-actuator.lua')
        -- Cancels the owned (queued) command; the next decision issues a fresh one.
        actuator.release(entry.motor)
    end)
    if (tonumber(level) or 1) == 2 then
        step('reattach-role', function()
            local ai = npc:GetAIControllerComponent()
            ai:SetAIRole(entry.role or ai:GetAIRole())
            ai:OnAttach()
        end)
    end
    if (tonumber(level) or 1) >= 3 then
        -- Workspot-related status effects can hold the behaviour tree in a
        -- status-effect branch (aiStatusEffectTask sets InPendingBehavior).
        step('remove-workspot-effects', function()
            local removed = {}
            for _, effect in ipairs(Game.GetStatusEffectSystem():GetAppliedEffects(npc:GetEntityID()) or {}) do
                local id = effect:GetRecord():GetID()
                local name = TDBID.ToStringDEBUG(id)
                if name:find('Workspot', 1, true) then
                    StatusEffectHelper.RemoveStatusEffect(npc, id); removed[#removed + 1] = name
                end
            end
            steps[#steps + 1] = {step = 'removed-effects', list = removed}
        end)
        -- Immediate in-place teleport resets locomotion/animation ownership.
        step('teleport-in-place', function()
            Game.GetTeleportationFacility():Teleport(npc, npc:GetWorldPosition(), npc:GetWorldOrientation():ToEulerAngles())
        end)
        -- Full role cycle, as dismissal then spawn attach do.
        step('role-cycle', function()
            local ai = npc:GetAIControllerComponent()
            if entry.role then pcall(function() entry.role:OnRoleCleared(npc) end) end
            ai:SetAIRole(NewObject('AINoRole')); ai:OnAttach()
            local role = NewObject('AIFollowerRole')
            role.followerRef = Game.CreateEntityReference('#player', {})
            ai:SetAIRole(role); ai:OnAttach()
            entry.role = role
        end)
    end
    local after = {flags = aiFlags(npc), inWorkspot = inWorkspot(npc)}
    log('unstick', {serial = s.serial, level = tonumber(level) or 1, before = before, steps = steps, after = after})
    s.unstickAt = now()
    return true, {before = before, steps = steps, after = after}
end

-- Lifecycle ----------------------------------------------------------------
local function finish(s, reason, forceDelete)
    if s.suspended and s.resumeHold then pcall(s.resumeHold) end
    s.suspended = false
    -- Hypothesis under test: deleting the device right after the exit may leave
    -- the AI waiting on a workspot owner that no longer exists. keepdevice=on
    -- (default) keeps it until clear/release/the next start.
    if forceDelete or not s.keepDevice then deleteDevice(s) end
    log('finished', {serial = s.serial, reason = reason, phase = s.phase,
        exitLatency = s.exitRequestedAt and (now() - s.exitRequestedAt) or nil,
        moved = distance(s.startPosition, s.entry and s.entry.npc and position(s.entry.npc))})
    s.phase, s.queue, s.clip, s.exitRequestedAt, s.exitMode = 'off', nil, nil, nil, nil
    s.traceUntil = now() + 3
    s.healthFrom, s.autoUnstuck = now(), nil
end
local function requestExit(s, reason, instant)
    if s.phase == 'off' or s.phase == 'failed' then return end
    local npc = s.entry and s.entry.npc
    s.queue, s.clip = nil, nil
    if s.phase ~= 'active' and s.phase ~= 'exiting' and s.phase ~= 'stopping' then finish(s, reason); return end
    s.exitReason, s.exitRequestedAt = s.exitReason or reason, s.exitRequestedAt or now()
    if instant then
        -- Instant fast exit, not StopNpcInWorkspot (which preceded every wedge).
        s.phase = 'stopping'
        if npc then exitWorkspot(s, npc, 'instant') end
    elseif s.phase == 'active' then
        s.phase = 'exiting'
        if npc then
            if s.exitStyle == 'fast' then exitWorkspot(s, npc, 'fast')
            else stopWorkspot(s, npc, s.exitStyle == 'npc' and 'npc' or 'device') end
        end
    end
    log('exit-requested', {serial = s.serial, reason = reason, instant = instant == true})
end

local function begin(s, words)
    local entry = s.entry
    if HOLDING[s.phase] then return false, 'already ' .. s.phase end
    local which = option(words, 'component', 'gestures')
    s.familyKey = option(words, 'family', character(entry).talk or 'on_sides')
    if not catalogData().families[s.familyKey] then return false, 'unknown family ' .. s.familyKey end
    if which == 'gestures' or which == 'talk' then s.component = familyOf(s).component
    elseif which == 'idle' then s.component = catalogData().idleComponents[character(entry).idle or 'generic']
    else s.component = catalogData().idleComponents[(which:gsub('^idle%-', ''))] end
    if not s.component then return false, 'unknown component ' .. which end
    s.variant = option(words, 'variant', 'keep')
    s.api = option(words, 'api', 'auto')
    s.autoReturn = option(words, 'return', 'on') ~= 'off'
    s.slide, s.slideTime = option(words, 'slide', 'dont'), option(words, 'slidetime', '0')
    s.exitStyle = option(words, 'exit', 'fast') -- fast (native defaults) | device | npc
    s.exitArgs = option(words, 'exitargs', 'default') -- default | full
    s.patience = option(words, 'patience', '3')
    s.harsh = option(words, 'harsh', 'off') == 'on'
    -- force=on starts even when the copy is not settled (recovery experiments).
    s.force = option(words, 'force', 'off') == 'on'
    s.keepDevice = option(words, 'keepdevice', 'on') ~= 'off'
    s.phase, s.startedAt, s.startPosition = s.variant == 'suspend' and 'suspending' or 'spawning', now(), position(entry.npc)
    s.beganTick, s.escalated1, s.escalated2 = M.tickCount, nil, nil
    s.deviceChecked = nil
    s.playerAnchor, s.unsettledSince = nil, nil
    s.exitReason, s.exitRequestedAt, s.failure, s.queue, s.clip = nil, nil, nil, nil, nil
    log('begin', {serial = s.serial, name = s.name, rig = s.rig, component = s.component, variant = s.variant, api = s.api,
        inWorkspot = inWorkspot(entry.npc)})
    return true, {serial = s.serial, component = s.component, variant = s.variant, api = s.api, rig = s.rig}
end

-- Commands -----------------------------------------------------------------
local COMMANDS = {}
local function each(words, apply)
    local rows = targets(words[2] or 'all')
    if #rows == 0 then return false, 'no matching ready companion' end
    local results = {}
    for _, row in ipairs(rows) do
        local s = stateFor(row.entry)
        local ok, result = apply(s, row)
        results[#results + 1] = {serial = s.serial, name = s.name, ok = ok, result = result}
    end
    return true, results
end
COMMANDS.list = function()
    local rows = {}
    for _, row in ipairs(M.rows or {}) do
        local entry = row.entry
        local s = M.states[entry.serial]
        rows[#rows + 1] = {serial = entry.serial, name = entry.name, record = entry.record, rig = rigOf(entry),
            talk = character(entry).talk, idleComponent = catalogData().idleComponents[character(entry).idle or 'generic'], phase = s and s.phase or 'off',
            behaviour = entry.person and entry.person.phase, transport = row.transport, inWorkspot = inWorkspot(entry.npc)}
    end
    local families = {}
    for key, family in pairs(catalogData().families) do families[key] = #family.clips end
    return true, {companions = rows, guard = M.guard, families = families, catalog = catalogData().version}
end
COMMANDS.clips = function(words)
    local rig = words[2] or 'woman_base'
    local rows = {}
    local probe = {rig = rig, familyKey = words[3] or 'on_sides', characterKey = words[4]}
    for _, item in ipairs(clipsFor(probe)) do rows[#rows + 1] = {index = item.index, name = item.clip.name, category = item.clip.category, duration = item.duration} end
    return true, rows
end
COMMANDS.start = function(words) return each(words, function(s) return begin(s, words) end) end
COMMANDS.jump = function(words)
    return each(words, function(s)
        if s.phase ~= 'active' then return false, 'not active (' .. s.phase .. ')' end
        local item = findClip(s, words[3] or '1')
        if not item then return false, 'unknown clip' end
        item.byId = option(words, 'by', 'name') == 'id'
        s.queue = nil
        local ok = jump(s, s.entry.npc, item, option(words, 'instant', 'off') == 'on')
        if ok and not item.idle then s.clip = {name = item.clip.name, endsAt = now() + item.duration, startedAt = now()} end
        return ok, item.clip.name
    end)
end
COMMANDS.demo = function(words)
    -- Plays every clip this rig has, in catalog order, returning to idle between.
    return each(words, function(s)
        if s.phase ~= 'active' then return false, 'not active (' .. s.phase .. ')' end
        s.queue = {}
        local only = option(words, 'category', nil)
        for _, item in ipairs(clipsFor(s)) do
            if (not only or item.clip.category == only) and item.clip.category ~= 'idlebreak' then s.queue[#s.queue + 1] = item end
        end
        s.nextAt = now() + 0.5
        return true, #s.queue .. ' clips queued'
    end)
end
COMMANDS.exit = function(words)
    return each(words, function(s)
        local npc = s.entry.npc
        if s.phase ~= 'active' then return false, 'not active (' .. s.phase .. ')' end
        s.queue, s.clip, s.exitReason, s.exitRequestedAt, s.phase = nil, nil, 'command', now(), 'exiting'
        return exitWorkspot(s, npc, words[3] == 'slow' and 'slow' or 'fast')
    end)
end
COMMANDS.stop = function(words)
    return each(words, function(s)
        if s.phase == 'off' then return false, 'not running' end
        s.queue, s.clip, s.exitReason, s.exitRequestedAt, s.phase = nil, nil, 'command', now(), 'stopping'
        return stopWorkspot(s, s.entry.npc, words[3] == 'device' and 'device' or 'npc')
    end)
end
COMMANDS.status = function(words)
    return each(words, function(s)
        local npc = s.entry.npc
        local info = {}
        local ok, extended = pcall(function() return workspots():GetExtendedInfo(npc) end)
        if ok and extended then
            for _, field in ipairs({'isActive', 'entering', 'exiting', 'isInIdle', 'isInSequence', 'sequenceId', 'idleName'}) do
                local read, value = pcall(function() return extended[field] end)
                if read and value ~= nil then info[field] = tostring(value) end
            end
            info.text = tostring(extended)
        else info.error = tostring(extended) end
        local motor = s.entry.motor or {}
        return true, {phase = s.phase, component = s.component, variant = s.variant, clip = s.clip and s.clip.name,
            inWorkspot = inWorkspot(npc), extended = info, behaviour = s.entry.person and s.entry.person.phase,
            hold = {kind = motor.kind, stage = motor.stage, state = motor.feedback and motor.feedback.state,
                suspended = motor.suspendedHold ~= nil}, position = position(npc)}
    end)
end
COMMANDS.unstick = function(words) return each(words, function(s) return unstick(s, words[3]) end) end
COMMANDS.diag = function(words)
    return each(words, function(s)
        local npc, out = s.entry.npc, {}
        out.flags, out.inWorkspot = aiFlags(npc), inWorkspot(npc)
        pcall(function()
            local info = workspots():GetExtendedInfo(npc)
            out.extended = {}
            for _, field in ipairs({'isActive', 'entering', 'exiting', 'playingSyncAnim', 'inReaction', 'inMotion'}) do
                out.extended[field] = info[field]
            end
        end)
        pcall(function()
            out.effects = {}
            for _, effect in ipairs(Game.GetStatusEffectSystem():GetAppliedEffects(npc:GetEntityID()) or {}) do
                out.effects[#out.effects + 1] = TDBID.ToStringDEBUG(effect:GetRecord():GetID())
            end
        end)
        pcall(function() out.highLevel = tostring(npc:GetHighLevelStateFromBlackboard()) end)
        pcall(function() out.autonomous = npc:IsOnAutonomousAI() end)
        pcall(function() out.role = npc:GetAIControllerComponent():GetAIRole():GetClassName().value end)
        pcall(function()
            local board, defs = npc:GetPuppetStateBlackboard(), Game.GetAllBlackboardDefs().PuppetState
            out.upperBody, out.stance = board:GetInt(defs.UpperBody), board:GetInt(defs.Stance)
        end)
        local motor = s.entry.motor or {}
        out.command = {kind = motor.kind, stage = motor.stage, state = motor.feedback and motor.feedback.state,
            id = motor.command and tonumber(motor.command.id), cancelling = motor.cancellation ~= nil}
        out.behaviour = s.entry.person and s.entry.person.phase
        log('diag', {serial = s.serial, diag = out})
        return true, out
    end)
end
-- Hot reload without CET "Reload all mods" (which despawns companions): the
-- file rebinds its functions onto this same table, so states and the
-- companions hook survive. Install the new gesture-probe.lua, then send reload.
COMMANDS.reload = function()
    local ok, result = pcall(dofile, 'gesture-probe.lua')
    if not ok then return false, tostring(result) end
    return true, {reloaded = result == M, states = (function() local n = 0; for _ in pairs(M.states) do n = n + 1 end; return n end)()}
end
-- Swap the Stage 1 controller (companion-gestures.lua, gesture-selection.lua,
-- gesture-workspot.lua, gesture-catalog.lua) without a CET reload.
COMMANDS['reload-controller'] = function()
    local old = convaiGestures
    if old and old.states then
        for _, state in pairs(old.states) do
            if state.phase ~= 'off' and state.entry then pcall(old.release, state.entry, 'reload') end
        end
    end
    if not convaiGestureOptions then return false, 'this init.lua predates hot reload' end
    local ok, controller = pcall(function() return dofile('companion-gestures.lua').new(convaiGestureOptions) end)
    if not ok then return false, tostring(controller) end
    convaiGestures = controller
    return true, {reloaded = true, families = (function()
        local list = {}
        for key in pairs(controller.catalog.families or {}) do list[#list + 1] = key end
        return list
    end)()}
end
-- Seating controller (docs/COMPANION_SEATING.md): snapshot, and hot reload of
-- companion-seating.lua without a CET reload.
COMMANDS.seating = function()
    if not convaiSeating then return false, 'seating controller not loaded' end
    return true, convaiSeating.snapshot()
end
COMMANDS['reload-seating'] = function()
    local old = convaiSeating
    if old and old.states then
        for _, state in pairs(old.states) do
            if state.phase ~= 'off' and state.entry then pcall(old.release, state.entry, 'reload') end
        end
    end
    if not convaiSeatingOptions then return false, 'this init.lua predates the seating controller' end
    local ok, controller = pcall(function() return dofile('companion-seating.lua').new(convaiSeatingOptions) end)
    if not ok then return false, tostring(controller) end
    convaiSeating = controller
    return true, controller.snapshot()
end
-- run <name> [args...]: research probe runtime/<name>.lua (returns a function of
-- words and this probe) without a CET reload. Names are letters, digits, - and _.
-- housemate <sub> ...: the housemates' development tools (mod/housemate-survey.lua, docs/HOUSEMATES.md "Phase 0").
COMMANDS.housemate = function(words)
    local loaded, module = pcall(dofile, 'housemate-survey.lua')
    if not loaded then return false, tostring(module) end
    return module.command(words)
end
COMMANDS.run = function(words)
    local name = words[2] or ''
    if not name:match('^[%w%-_]+$') then return false, 'probe name must be letters, digits, - or _' end
    local loaded, fn = pcall(dofile, 'runtime/' .. name .. '.lua')
    if not loaded then return false, tostring(fn) end
    if type(fn) ~= 'function' then return false, 'probe file must return a function' end
    local ok, result = pcall(fn, words, M)
    if not ok then return false, tostring(result) end
    return true, result
end
-- flats <record>...: entity template of character records (hash and text), to
-- find each character's relaxed locomotion idle offline.
COMMANDS.flats = function(words)
    local out = {}
    for index = 2, #words do
        local record = words[index]
        local row = {}
        local ok, value = pcall(function() return TweakDB:GetFlat(record .. '.entityTemplatePath') end)
        row.ok, row.text = ok, tostring(value)
        if ok and value ~= nil then
            pcall(function() row.hash = tostring(value.hash) end)
            pcall(function() row.value = tostring(value.value) end)
        end
        pcall(function() row.appearance = tostring(TweakDB:GetFlat(record .. '.appearanceName')) end)
        out[record] = row
    end
    log('flats', {flats = out})
    return true, out
end
COMMANDS.autounstick = function(words) M.autoUnstick = words[2] ~= 'off'; return true, {autoUnstick = M.autoUnstick} end
COMMANDS.guard = function(words)
    M.guard = words[2] ~= 'off'
    return true, {guard = M.guard}
end
COMMANDS.clear = function()
    for _, s in pairs(M.states) do
        if s.phase ~= 'off' and s.entry and s.entry.npc then pcall(exitWorkspot, s, s.entry.npc, 'instant') end
        finish(s, 'clear', true)
    end
    return true, 'cleared'
end
COMMANDS.sigs = function()
    -- Codeware reflection: exact native signatures for the calls above.
    local report = {}
    local function describe(className)
        local ok, result = pcall(function()
            local class = Reflection.GetClass(CName.new(className))
            if not class then return 'class not found' end
            local functions = {}
            for _, fn in ipairs(class:GetFunctions()) do
                local name = tostring(fn:GetName().value or fn:GetName())
                local params = {}
                local pok = pcall(function()
                    for _, param in ipairs(fn:GetParameters()) do
                        local optional = ''
                        pcall(function() if param:IsOptional() then optional = '?' end end)
                        params[#params + 1] = tostring(param:GetName().value) .. optional .. ':' .. tostring(param:GetType():GetName().value)
                    end
                end)
                local returns = ''
                pcall(function() returns = tostring(fn:GetReturnType():GetName().value) end)
                functions[#functions + 1] = name .. '(' .. (pok and table.concat(params, ', ') or '?') .. ')' .. (returns ~= '' and (' -> ' .. returns) or '')
            end
            local properties = {}
            pcall(function()
                for _, prop in ipairs(class:GetProperties()) do
                    properties[#properties + 1] = tostring(prop:GetName().value) .. ':' .. tostring(prop:GetType():GetName().value)
                end
            end)
            return {functions = functions, properties = properties}
        end)
        report[className] = ok and result or ('error: ' .. tostring(result))
    end
    for _, className in ipairs({'gameWorkspotGameSystem', 'workWorkspotResourceComponent', 'DynamicEntitySpec',
        'gameExtendedWorkspotInfo', 'ExtendedWorkspotInfo', 'workWorkEntryId', 'WorkspotSlidingBehaviour'}) do
        describe(className)
    end
    log('signatures', {report = report})
    return true, 'written to gesture-probe.log'
end

local function poll()
    local file = io.open(REQUEST, 'rb')
    if not file then return end
    local raw = file:read('*a'); file:close()
    local nonce, command = tostring(raw):match('^([^\r\n]+)\r?\n(.*)$')
    if not nonce or nonce == M.lastNonce then return end
    M.lastNonce = nonce
    local words = split(command)
    local handler = COMMANDS[words[1] or '']
    log('request', {nonce = nonce, command = command})
    if not handler then respond(nonce, false, 'unknown command'); return end
    local ok, success, result = pcall(handler, words)
    if not ok then respond(nonce, false, tostring(success)) else respond(nonce, success, result) end
end

-- Per-copy update from the companions loop ----------------------------------
local function trace(s, context)
    if s.phase == 'off' and now() > (s.traceUntil or 0) + 7 then return end
    if now() < (s.traceAt or 0) then return end
    s.traceAt = now() + 0.25
    local entry, motor = s.entry, s.entry.motor or {}
    log('trace', {serial = s.serial, phase = s.phase, clip = s.clip and s.clip.name, inWorkspot = inWorkspot(entry.npc),
        idle = context and context.idle, combat = context and context.combat, behaviour = context and context.phase,
        speed = entry.speed and math.floor(entry.speed * 100) / 100, position = position(entry.npc), flags = aiFlags(entry.npc),
        settled = context and context.settled,
        hold = {kind = motor.kind, stage = motor.stage, state = motor.feedback and motor.feedback.state, suspended = motor.suspendedHold ~= nil}})
end

local function advance(s, context)
    local npc = s.entry.npc
    if s.phase == 'suspending' then
        if not context.idle and not s.force then finish(s, 'not settled before start'); return end
        s.resumeHold = context.resumeHold
        local ok, ready, reason = pcall(context.suspendHold)
        if ok and ready == true then s.suspended = true; s.phase = 'spawning'; log('hold-suspended', {serial = s.serial})
        elseif not ok or now() - s.startedAt > 2 then s.failure = ok and tostring(reason) or tostring(ready); finish(s, 'hold suspension failed') end
        return
    end
    if s.phase == 'spawning' then
        if not context.idle and not s.force then finish(s, 'not settled before start'); return end
        if s.deviceID and not s.deviceChecked then
            s.deviceChecked = true
            local ok, managed = pcall(function() return Game.GetDynamicEntitySystem():IsManaged(s.deviceID) end)
            if not ok or not managed then s.deviceID, s.device = nil, nil
            else
                -- Reused devices must sit at the actor's current transform.
                pcall(function() Game.GetTeleportationFacility():Teleport(s.device or Game.FindEntityByID(s.deviceID), npc:GetWorldPosition(), npc:GetWorldOrientation():ToEulerAngles()) end)
                s.deviceRequestedAt = now()
            end
        end
        if not s.deviceID then
            local ok, err = pcall(spawnDevice, s, npc)
            if not ok then s.failure = tostring(err); log('device-error', {serial = s.serial, error = s.failure}); finish(s, 'device spawn failed') end
            return
        end
        local system = Game.GetDynamicEntitySystem()
        if system:IsSpawned(s.deviceID) then
            s.device = Game.FindEntityByID(s.deviceID)
            if s.device then
                local typed, className = pcall(function() return s.device:GetClassName().value end)
                log('device-ready', {serial = s.serial, after = now() - s.deviceRequestedAt, type = typed and tostring(className) or 'unknown'})
                s.phase = 'starting'
                if play(s, npc) then s.playAt = now() else finish(s, 'play failed') end
            end
        elseif now() - s.deviceRequestedAt > 5 then finish(s, 'device spawn timed out') end
        return
    end
    if s.phase == 'starting' then
        local value = inWorkspot(npc)
        if value == true then s.phase, s.activeAt = 'active', now(); log('active', {serial = s.serial, after = now() - s.playAt, position = position(npc)})
        elseif now() - s.playAt > 3 then finish(s, 'never entered workspot (inWorkspot=' .. tostring(value) .. ')') end
        if s.phase ~= 'active' then return end
    end
    if s.phase == 'exiting' or s.phase == 'stopping' then
        local value = inWorkspot(npc)
        if value ~= true then finish(s, s.exitReason or 'exited'); return end
        local waited = now() - (s.exitRequestedAt or now())
        -- Watchdog. Every wedge so far followed a StopNpcInWorkspot escalation at
        -- .6 s; the one clean case was a fast exit that finished on its own. Wait
        -- `patience` s (default 3), then StopInDevice; StopNpcInWorkspot only
        -- with harsh=on.
        local patience = tonumber(s.patience) or 3
        if waited > patience and not s.escalated1 then s.escalated1 = true; stopWorkspot(s, npc, 'device') end
        if s.harsh and waited > patience + 1.5 and not s.escalated2 then s.escalated2 = true; stopWorkspot(s, npc, 'npc') end
        if waited > patience + 3 then s.failure = 'still in workspot after escalation'; finish(s, 'stuck'); s.phase = 'failed' end
        return
    end
    s.escalated1, s.escalated2 = nil, nil
    if s.phase ~= 'active' then return end
    if inWorkspot(npc) ~= true then finish(s, 'left workspot on its own'); return end
    if M.guard and context.combat then requestExit(s, 'combat', true); return end
    -- Movement means real V translation (> .75 m from where V stood when the
    -- stance began), V running, or a non-settled decision that persists for
    -- .8 s. Single-tick flickers of the group frame (camera turns, opening the
    -- chat/mic, small shifts) and the copy's own entry settle are ignored.
    local settled = context.settled
    if settled == nil then settled = context.idle end
    if settled then s.unsettledSince = nil else s.unsettledSince = s.unsettledSince or now() end
    s.playerAnchor = s.playerAnchor or M.playerPosition
    local moved = distance(s.playerAnchor, M.playerPosition) or 0
    local reason = (moved > .75 and 'player-moved') or ((M.playerSpeed or 0) > 2.5 and 'player-running')
        or (s.unsettledSince and now() - s.unsettledSince > .8 and 'unsettled') or nil
    if M.guard and reason then
        log('guard', {serial = s.serial, reason = reason, playerMoved = moved, playerSpeed = M.playerSpeed,
            unsettledFor = s.unsettledSince and now() - s.unsettledSince or 0})
        requestExit(s, 'movement:' .. reason, false); return
    end
    if s.clip and now() >= s.clip.endsAt - 0.2 then
        local clip = s.clip
        s.clip = nil
        if s.autoReturn then jump(s, npc, {idle = true, clip = {name = familyOf(s).idle.name}}, false) end
        log('clip-ended', {serial = s.serial, clip = clip.name, autoReturn = s.autoReturn})
        s.nextAt = now() + 1.0
    end
    if s.queue and not s.clip and now() >= (s.nextAt or 0) then
        local item = table.remove(s.queue, 1)
        if not item then s.queue = nil; log('demo-finished', {serial = s.serial}); return end
        if jump(s, npc, item, false) then s.clip = {name = item.clip.name, endsAt = now() + item.duration, startedAt = now()} end
    end
end

function M.observe(entry, context, step)
    local s = M.states[entry.serial]
    if not s then return false end
    s.entry, s.observedTick = entry, M.tickCount
    local ok, err = pcall(advance, s, context or {})
    if not ok then
        log('advance-error', {serial = s.serial, error = tostring(err)})
        pcall(requestExit, s, 'error', true)
    end
    -- After a workspot ends, the AI must start the next command. If a move is
    -- wanted but the owned command is still only queued after 1 s, recover.
    if s.phase == 'off' and s.healthFrom and now() - s.healthFrom < 10 then
        local state = s.entry.motor and s.entry.motor.feedback and tostring(s.entry.motor.feedback.state or '')
        if state and state:find('Enqueued', 1, true) and context.settled == false and now() - s.healthFrom > 1 and not s.autoUnstuck then
            s.autoUnstuck = true
            log('ai-wedged', {serial = s.serial, state = state, flags = aiFlags(s.entry.npc), sinceExit = now() - s.healthFrom})
            if M.autoUnstick ~= false then pcall(unstick, s, 1) end
        end
    end
    trace(s, context)
    return HOLDING[s.phase] == true
end

function M.tick(player, step, rows)
    M.clock = M.clock + (tonumber(step) or 0)
    M.tickCount = M.tickCount + 1
    M.rows = rows
    -- Research watchers installed by `run` probes (M.watchers[name] = fn).
    for name, watch in pairs(M.watchers or {}) do
        local ok, err = pcall(watch, player, step, rows, log)
        if not ok then M.watchers[name] = nil; log('watcher-error', {name = name, error = tostring(err)}) end
    end
    local at = player and position(player)
    if at then
        local dt = tonumber(step) or 0
        M.playerSpeed = M.playerPosition and dt > 0 and (distance(M.playerPosition, at) or 0) / dt or 0
        M.playerPosition = at
    end
    if not M.swept then
        -- A CET reload can leave devices from a previous session in the world.
        M.swept = true
        pcall(function()
            local system = Game.GetDynamicEntitySystem()
            for _, id in ipairs(system:GetTaggedIDs(CName.new(TAG)) or {}) do system:DeleteEntity(id) end
        end)
    end
    local present = {}
    for _, row in ipairs(rows or {}) do
        present[row.entry.serial] = row
        local s = M.states[row.entry.serial]
        if s then s.entry = row.entry end
    end
    for serial, s in pairs(M.states) do
        local row = present[serial]
        if not row then
            -- Detached/dead/dismissed: no native calls on a vanishing actor.
            if s.phase ~= 'off' then deleteDevice(s); log('abandoned', {serial = serial, phase = s.phase}) end
            M.states[serial] = nil
        elseif HOLDING[s.phase] and (row.transport or (s.observedTick or 0) < M.tickCount - 1) and M.tickCount > (s.beganTick or 0) + 1 then
            -- Transport, recovery, tactics or any other owner took the copy.
            requestExit(s, row.transport and 'transport' or 'unobserved', true)
        end
    end
    if M.clock >= M.pollAt then
        -- Developer mailbox: one CET io.open costs 1-2 ms of the game thread, so poll once a second (every 4 s with
        -- Developer mode off; init.lua's convaiDevMailboxPeriod).
        M.pollAt = M.clock + (M.pollPeriod or (convaiDevMailboxPeriod and convaiDevMailboxPeriod()) or 1)
        local ok, err = pcall(poll)
        if not ok then log('poll-error', {error = tostring(err)}) end
    end
end

function M.release(entry, reason)
    local s = M.states[entry.serial]
    if not s or s.phase == 'off' then return end
    if entry.npc and HOLDING[s.phase] then pcall(stopWorkspot, s, entry.npc, 'npc') end
    finish(s, reason or 'released', true)
end

function M.abandon(reason)
    for serial, s in pairs(M.states) do
        if s.phase ~= 'off' then log('abandoned', {serial = serial, reason = reason}) end
    end
    M.states, M.rows = {}, nil
end

convaiGestureProbe = M
return M
