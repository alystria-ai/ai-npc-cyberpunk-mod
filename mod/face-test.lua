-- Development probe: does a deliberately EXTREME facial pose become visible on a
-- companion? Inert until a request arrives in runtime/face-test-request.txt
--   line 1: a fresh nonce, line 2: face-test <who> <pose> [seconds] [mode]
-- (scripts/Send-FaceTest.ps1 writes it). Results: runtime/face-test-response.txt
-- (nonce + JSON) and a JSON-lines trace in runtime/face-test.log.
--
-- It is driven from mod/facial-playback.lua (the single native face writer):
-- poll() once per frame, pre()/post() around its feature composition, and
-- direct() before its idle write. It never changes speech weights.
--
-- Modes:
--   writer  after the writer composed speech + expression, the pose is written
--           over the ten expression fields (no caps, no smoothing). Mouth fields
--           (jaw, lips_together, funnel, purse...) are never touched, so this also
--           works WHILE the companion speaks.
--   policy  injects the real policy at scale 3 (joy, sadness, surprise, anger)
--           through the normal smoothing, caps and mouth-priority budget. Use it
--           to see the real strength and the speech interaction.
--   direct  bypasses the writer: its own ConvaiFaceFeature, ConvaiFaceApply every
--           frame, the writer skipped for that actor. Pure write-path test (use
--           while she is silent).
-- Poses: smile frown browsup browsdown jaw all sweep ramp-smile ramp-frown
--        ramp-brows custom:<track>=<value>,...
local M = convaiFaceTest or {}
local REQUEST, RESPONSE, LOG = 'runtime/face-test-request.txt', 'runtime/face-test-response.txt', 'runtime/face-test.log'
local EXPRESSION = {'lips_l_corner_up','lips_r_corner_up','lips_l_corner_dn','lips_r_corner_dn',
    'eye_l_brows_raise_in','eye_r_brows_raise_in','eye_l_brows_raise_out','eye_r_brows_raise_out',
    'eye_l_brows_lower','eye_r_brows_lower','eye_l_oculi_squint_outer_lower','eye_r_oculi_squint_outer_lower',
    'eye_l_widen','eye_r_widen',
    -- Extended controls (present only with the new FaceFeature.reds; every access below is guarded).
    'eye_l_brows_lateral','eye_r_brows_lateral','eye_l_oculi_squint_outer_upper','eye_r_oculi_squint_outer_upper',
    'eye_l_oculi_squint_inner','eye_r_oculi_squint_inner','nose_l_snear','nose_r_snear','lips_chin_raise'}
local policyFamily = {smile='Joy', frown='Sadness', browsup='Surprise', browsdown='Anger', all='Joy'}

M.clock, M.pollAt, M.lastNonce = M.clock or 0, M.pollAt or 0, M.lastNonce
-- Non-expression fields (jaw, ...) ever written into a writer feature, per
-- entity. The writer keeps its idle feature between frames, so these must be
-- zeroed when a step or run ends or they stay on the face (the jaw .5 bug).
M.touched = M.touched or {}
local EXPRESSION_SET = {}
for _, name in ipairs(EXPRESSION) do EXPRESSION_SET[name] = true end

local function encode(value)
    local ok, text = pcall(json.encode, value)
    return ok and text or ('{"encodeError":' .. string.format('%q', tostring(text)) .. '}')
end
local function log(kind, fields)
    fields = fields or {}
    fields.kind, fields.at, fields.wall = kind, math.floor(M.clock * 1000) / 1000, os.time()
    local file = io.open(LOG, 'a')
    if file then file:write(encode(fields), '\n'); file:close() end
end
local function respond(nonce, ok, result)
    local file = io.open(RESPONSE, 'wb')
    if file then file:write(nonce, '\n', encode({ok = ok, result = result})); file:close() end
    log('response', {nonce = nonce, ok = ok, result = result})
end

local function pair(stem, value) return {['lips_l_' .. stem] = value, ['lips_r_' .. stem] = value} end
local function brows(stem, value) return {['eye_l_brows_' .. stem] = value, ['eye_r_brows_' .. stem] = value} end
local function merge(...)
    local out = {}
    for _, part in ipairs({...}) do for k, v in pairs(part) do out[k] = v end end
    return out
end
local base = {
    smile = function(v) return pair('corner_up', v) end,
    frown = function(v) return pair('corner_dn', v) end,
    browsup = function(v) return merge(brows('raise_in', v), brows('raise_out', v)) end,
    browsdown = function(v) return brows('lower', v) end,
    jaw = function(v) return {jaw_mid_open = v * .5} end,
    -- Eye squint alone, and a Duchenne smile (corners + squint) to compare with plain smile.
    squint = function(v) return {eye_l_oculi_squint_outer_lower = v, eye_r_oculi_squint_outer_lower = v} end,
    duchenne = function(v) return merge(pair('corner_up', v * .45), {eye_l_oculi_squint_outer_lower = v * .3, eye_r_oculi_squint_outer_lower = v * .3}) end,
}
local function steps(pose, seconds)
    local out = {}
    local function add(label, tracks, share) out[#out + 1] = {label = label, tracks = tracks, share = share or 1} end
    if base[pose] then add(pose, base[pose](1))
    elseif pose == 'all' then add('all', merge(base.smile(1), base.browsup(1)))
    elseif pose == 'sweep' then
        for _, name in ipairs({'smile', 'frown', 'browsup', 'browsdown', 'jaw'}) do add(name, base[name](1)) end
    elseif pose:sub(1, 5) == 'ramp-' then
        local kind = ({smile = 'smile', frown = 'frown', brows = 'browsup'})[pose:sub(6)]
        if not kind then return nil, 'unknown ramp' end
        for _, level in ipairs({.1, .2, .35, .5, .75, 1}) do add(pose .. '@' .. level, base[kind](level)) end
    elseif pose:sub(1, 7) == 'custom:' then
        local tracks = {}
        for name, value in pose:sub(8):gmatch('([%w_]+)=([%-%d%.]+)') do tracks[name] = tonumber(value) end
        if next(tracks) == nil then return nil, 'custom needs track=value,...' end
        add('custom', tracks)
    else return nil, 'unknown pose' end
    return out
end

local function rowFor(context, who)
    who = who:lower()
    for _, row in ipairs(context.actors or {}) do
        local profile, name = tostring(row.profileKey or ''):lower(), tostring(row.name or ''):lower()
        if who == 'first' or profile:find(who, 1, true) or name:find(who, 1, true) then return row end
    end
end

local commands = {}
commands['face-test'] = function(rest, context)
    local who, pose, seconds, mode = rest:match('^(%S+)%s+(%S+)%s*(%S*)%s*(%S*)$')
    if not who then return false, 'usage: face-test <who> <pose> [seconds] [writer|policy|direct]' end
    seconds, mode = tonumber(seconds) or 6, (mode ~= '' and mode) or 'writer'
    if mode ~= 'writer' and mode ~= 'policy' and mode ~= 'direct' then return false, 'mode must be writer, policy or direct' end
    if pose == 'off' then M.run = nil; return true, 'stopped (probe fields cleared)' end
    local list, problem = steps(pose, seconds)
    if not list then return false, problem end
    local row = rowFor(context, who)
    if not row then return false, 'no owned companion matching ' .. who .. ' in range' end
    seconds = math.max(1, math.min(60, seconds))
    local per = (pose == 'sweep' or pose:sub(1, 5) == 'ramp-') and seconds / #list or seconds
    M.run = {entity = row.entity, name = row.name, profile = row.profileKey, pose = pose, mode = mode,
        steps = list, per = per, duration = per * #list, elapsed = 0, logAt = 0, frames = 0}
    log('start', {who = who, pose = pose, mode = mode, seconds = M.run.duration, entity = row.entity})
    return true, {started = pose, mode = mode, seconds = M.run.duration, companion = row.name or row.profileKey}
end

-- ---------------------------------------------------------------------------
-- face-stage: put a companion in front of V's camera, facing it, so a capture batch needs no manual framing.
--   face-stage <key> [hold-seconds]   key = a companion definition / profile key (evelyn-parker, panam-palmer, an
--                                     archetype key). An already present copy is reused; otherwise one is invited
--                                     through the party queue (the phone / manager path) and waited for.
--   face-stage status                 {state, name, placed, ...}: spawning | staged | released | lost | failed
--   face-stage off                    stop holding (her own movement takes over again)
--   face-stage dismiss                dismiss the characters this probe invited (never one that was already there)
-- Dev only (this file is not in a player package). One position check every .1 s for at most the hold (default 60 s,
-- limit 300 s), only while a stage is active, and an AI teleport command only when she is off the spot; nothing
-- otherwise. A visible placement is fine for a probe.
local STAGE_DISTANCE, STAGE_DEFAULT_HOLD, STAGE_MAX_HOLD, STAGE_SPAWN_WAIT, STAGE_PERIOD, STAGE_RESEND = .85, 60, 300, 30, .1, .25
M.spawned = M.spawned or {}

local function stageTarget()
    local player = Game.GetPlayer()
    if not player then return nil, 'no player' end
    local ok, _, forward = pcall(function() return Game.GetTargetingSystem():GetCrosshairData(player) end)
    if not ok or not forward then forward = player:GetWorldForward() end
    local length = forward and math.sqrt(forward.x * forward.x + forward.y * forward.y) or 0
    if length < 1e-3 then return nil, 'no camera direction' end
    local fx, fy = forward.x / length, forward.y / length
    local at = player:GetWorldPosition()
    -- Yaw convention: forward = (-sin yaw, cos yaw), so the camera's yaw is atan2(-fx, fy); she turns the other way.
    local atan2 = math.atan2 or math.atan -- LuaJIT (the game) has atan2; Lua 5.3 takes two arguments in atan
    local yaw = math.deg(atan2(-fx, fy)) + 180
    return {x = at.x + fx * STAGE_DISTANCE, y = at.y + fy * STAGE_DISTANCE, z = at.z, yaw = yaw}
end

local function stageTick(context)
    local stage = M.stage
    if not stage or stage.state == 'released' or stage.state == 'lost' or stage.state == 'failed' then return end
    if M.clock < stage.nextAt then return end
    stage.nextAt = M.clock + STAGE_PERIOD
    local row = context and rowFor(context, stage.who)
    if stage.state == 'spawning' then
        if row then stage.state, stage.entity, stage.name, stage.until_ = 'staged', row.entity, row.name, M.clock + stage.hold
        elseif M.clock > stage.deadline then stage.state, stage.error = 'failed', 'the copy did not become ready in time'; return
        else return end
    end
    if M.clock >= stage.until_ then stage.state = 'released'; log('stage-released', {who = stage.who, placed = stage.placed}); return end
    local current
    if row and row.entity == stage.entity then current = row
    else for _, other in ipairs(context and context.actors or {}) do if other.entity == stage.entity then current = other end end end
    if not current then stage.state = 'lost'; log('stage-lost', {who = stage.who}); return end
    local target, why = stageTarget()
    if not target then stage.state, stage.error = 'failed', why; return end
    -- A transform teleport is undone by the copy's own locomotion (seen live: she stayed beside V), so the placement is
    -- an AITeleportCommand through her AI controller, the actuator's own mechanism. It is sent only when she is not
    -- already there (more than .08 m or 6 degrees off), at most every .25 s; once placed she simply stays.
    local ok, err = pcall(function()
        local at = current.npc:GetWorldPosition()
        local off = math.sqrt((at.x - target.x) ^ 2 + (at.y - target.y) ^ 2 + (at.z - target.z) ^ 2)
        local turn = math.abs((current.npc:GetWorldYaw() - target.yaw + 180) % 360 - 180)
        if (off > .08 or turn > 6) and M.clock >= (stage.sendAt or 0) then
            local command = NewObject('AITeleportCommand')
            command.position = Vector4.new(target.x, target.y, target.z, 1)
            command.rotation = target.yaw
            command.doNavTest = false
            current.npc:GetAIControllerComponent():SendCommand(command)
            stage.placed, stage.sendAt = stage.placed + 1, M.clock + STAGE_RESEND
        end
        -- A walking companion keeps leaving the spot, so she is also told to hold position (re-sent every 5 s; the
        -- command class is optional: if the game lacks it the stage still works, only less steadily).
        if M.clock >= (stage.holdAt or 0) then
            stage.holdAt = M.clock + 5
            pcall(function()
                local hold = NewObject('AIHoldPositionCommand')
                if hold then
                    hold.duration = math.max(1, stage.until_ - M.clock) + 1
                    hold.ignoreInCombat = false
                    hold.removeAfterCommandCompletion = true
                    current.npc:GetAIControllerComponent():SendCommand(hold)
                end
            end)
        end
    end)
    if not ok then stage.state, stage.error = 'failed', tostring(err) end
end

commands['face-stage'] = function(rest, context)
    local word, tail = rest:match('^(%S+)%s*(.*)$')
    if not word then return false, 'usage: face-stage <key> [hold-seconds] | status | off | dismiss' end
    if word == 'status' then
        local stage = M.stage
        if not stage then return true, {state = 'none'} end
        return true, {state = stage.state, who = stage.who, name = stage.name, placed = stage.placed, error = stage.error,
            spawnedHere = stage.spawnedHere, hold = stage.hold}
    elseif word == 'off' then
        if M.stage then M.stage.state = 'released' end
        return true, 'released'
    elseif word == 'dismiss' then
        -- Only characters this probe invited (their key was absent at the time): through the party queue's own
        -- dismissal, which removes the copy (or cancels a still pending invitation) at the next gameplay flush.
        local done = {}
        local queue = convaiManager and convaiManager.party and convaiManager.party()
        for index = #M.spawned, 1, -1 do
            local key = M.spawned[index]
            local ok, rows = pcall(function() return queue.list() end)
            for _, member in ipairs(ok and rows or {}) do
                if member.key == key then
                    local called, accepted, message = pcall(queue.dismiss, member.id)
                    done[#done + 1] = {key = key, id = member.id, ok = called and accepted == true, result = called and message or tostring(accepted)}
                end
            end
            table.remove(M.spawned, index)
        end
        if M.stage then M.stage.state = 'released' end
        return true, {dismissed = done}
    end
    local hold = math.max(5, math.min(STAGE_MAX_HOLD, tonumber(tail) or STAGE_DEFAULT_HOLD))
    if not convaiCompanions then return false, 'companion runtime not loaded' end
    local stage = {who = word, hold = hold, state = 'spawning', placed = 0, nextAt = 0, deadline = M.clock + STAGE_SPAWN_WAIT}
    if rowFor(context, word) then
        stage.state = 'spawning' -- picked up on the next tick; no new copy
    else
        local listed = {}
        local ok, rows = pcall(convaiCompanions.list)
        for _, row in ipairs(ok and rows or {}) do
            if row.key == word or tostring(row.profileKey or '') == word then listed[#listed + 1] = row end
        end
        if #listed == 0 then
            -- The real invitation path (manager-party queue): preparation, then the spawn on the next gameplay flush.
            local queue = convaiManager and convaiManager.party and convaiManager.party()
            if not queue then return false, 'the party queue is not available' end
            local called, accepted, message = pcall(queue.invite, word)
            if not called or not accepted then return false, 'invitation refused: ' .. tostring(called and message or accepted) end
            M.spawned[#M.spawned + 1] = word
            stage.spawnedHere = true
        end
    end
    M.stage = stage
    log('stage', {who = word, hold = hold, spawned = stage.spawnedHere == true})
    return true, {staging = word, hold = hold, spawnedHere = stage.spawnedHere == true}
end

local function step(run)
    return run.steps[math.min(#run.steps, math.floor(run.elapsed / run.per) + 1)]
end

-- Called once per frame from the facial writer's frame start.
function M.poll(delta, context)
    delta = (type(delta) == 'number' and delta == delta and delta > 0 and delta < .5) and delta or 0
    M.clock = M.clock + delta
    if M.stage then local ok, err = pcall(stageTick, context); if not ok then M.stage.state, M.stage.error = 'failed', tostring(err) end end
    local run = M.run
    if run then
        run.elapsed = run.elapsed + delta
        if run.elapsed >= run.duration then
            log('finished', {pose = run.pose, mode = run.mode, frames = run.frames})
            M.run = nil
        elseif context and context.actors then
            local present = false
            for _, row in ipairs(context.actors) do if row.entity == run.entity then present = true end end
            if not present then log('target-lost', {pose = run.pose}); M.run = nil end
        end
    end
    if M.clock < M.pollAt then return end
    -- Developer mailbox: one CET io.open costs 1-2 ms of the game thread, so poll once a second.
    M.pollAt = M.clock + (M.pollPeriod or 1)
    local file = io.open(REQUEST, 'rb')
    if not file then return end
    local raw = file:read('*a'); file:close()
    local nonce, command = tostring(raw):match('^([^\r\n]+)\r?\n(.*)$')
    if not nonce or nonce == M.lastNonce then return end
    M.lastNonce = nonce
    command = command:gsub('^%s+', ''):gsub('%s+$', '')
    log('request', {nonce = nonce, command = command})
    local name, rest = command:match('^(%S+)%s*(.*)$')
    local handler = name and commands[name]
    if not handler then respond(nonce, false, 'unknown command'); return end
    local ok, success, result = pcall(handler, rest, context or {})
    if not ok then respond(nonce, false, tostring(success)) else respond(nonce, success, result) end
end

local function active(entity, mode)
    local run = M.run
    return run and run.entity == entity and (mode == nil or run.mode == mode) and run or nil
end

-- Before the writer composes expression: policy mode injects a scale-3 feeling.
M.policyTouched = M.policyTouched or {}
function M.pre(entity, slot, clock)
    local run = active(entity, 'policy')
    if not run then
        -- A policy run that ended (off, finished, replaced) must leave no injected
        -- feeling behind: clear it so the writer returns to its real resting state.
        if M.policyTouched[entity] then
            slot.emotion, slot.family, slot.scale, slot.expiry, slot.holdMix, slot.browExpiry = nil, nil, nil, nil, nil, nil
            slot.flick = {}
            M.policyTouched[entity] = nil
        end
        return
    end
    M.policyTouched[entity] = true
    local label = policyFamily[step(run).label:match('^[^@]+')] or ({['ramp-smile']='Joy',['ramp-frown']='Sadness',['ramp-brows']='Surprise'})[run.pose]
    if label then
        slot.emotion, slot.scale, slot.expiry = label, 3, nil
        slot.family = label:lower() == 'joy' and 'joy' or label:lower() == 'sadness' and 'sadness'
            or label:lower() == 'surprise' and 'surprise' or 'anger'
        -- Surprise is a 1 s flick by design (gone by 2 s); a still capture needs its peak, so the probe keeps it fresh.
        if slot.family == 'surprise' and slot.flick then slot.flick.surprise = 0 end
    end
end

local function snapshot(feature, run, tracks)
    local written = {}
    for _, name in ipairs(EXPRESSION) do
        local ok, value = pcall(function() return feature[name] end)
        if ok and type(value) == 'number' and value ~= 0 then written[name] = math.floor(value * 1000) / 1000 end
    end
    for name in pairs(tracks or {}) do
        local ok, value = pcall(function() return feature[name] end)
        written[name] = ok and type(value) == 'number' and math.floor(value * 1000) / 1000 or 'unreadable'
    end
    return written
end

local function trace(run, label, feature, tracks, extra)
    if run.elapsed < run.logAt then return end
    run.logAt = run.elapsed + .5
    local mouth = {}
    for _, name in ipairs({'jaw_mid_open', 'lips_together_up', 'lips_l_funnel', 'lips_l_purse'}) do
        local ok, value = pcall(function() return feature[name] end)
        if ok and type(value) == 'number' and value ~= 0 then mouth[name] = math.floor(value * 1000) / 1000 end
    end
    local record = {pose = run.pose, step = label, mode = run.mode, entity = run.entity, frames = run.frames,
        written = snapshot(feature, run, tracks), mouth = mouth}
    for k, v in pairs(extra or {}) do record[k] = v end
    log('frame', record)
end

-- After the writer composed the feature, before ConvaiFaceApply. Writer mode
-- overwrites only the ten expression fields: no caps, no smoothing, mouth intact.
-- Returns true when the write must be skipped (direct mode owns the actor).
function M.post(entity, feature, phase, blocked)
    local run = active(entity)
    if not run then
        -- Probe ended (off, finished, replaced): clear every leftover probe field
        -- from this idle feature. A speaking feature is rewritten by speech itself.
        local touched = M.touched[entity]
        if touched and phase ~= 'speaking' then
            for name in pairs(touched) do pcall(function() feature[name] = 0 end) end
            M.touched[entity] = nil
        end
        return false
    end
    if run.mode == 'direct' then return true end
    local current = step(run)
    run.frames = run.frames + 1
    if run.mode == 'writer' then
        for _, name in ipairs(EXPRESSION) do pcall(function() feature[name] = current.tracks[name] or 0 end) end
        -- Extra tracks of a custom pose (for example jaw_mid_open as a control).
        local touched = M.touched[entity] or {}
        M.touched[entity] = touched
        for name in pairs(touched) do
            if current.tracks[name] == nil then pcall(function() feature[name] = 0 end); touched[name] = nil end
        end
        for name, value in pairs(current.tracks) do
            if not EXPRESSION_SET[name] then touched[name] = true end
            pcall(function() feature[name] = value end)
        end
    end
    trace(run, current.label, feature, current.tracks, {phase = phase, blocked = blocked == true})
    return false
end

-- Direct mode: own feature, own apply, every frame, writer bypassed.
function M.direct(rows, createFeature)
    local run = M.run
    if not run or run.mode ~= 'direct' then return end
    for _, row in ipairs(rows or {}) do
        if row.entity == run.entity then
            local current = step(run)
            local feature = createFeature()
            local failed
            for name, value in pairs(current.tracks) do
                local ok = pcall(function() feature[name] = value end)
                if not ok then failed = (failed and failed .. ',' or '') .. name end
            end
            run.frames = run.frames + 1
            local ok, applied = pcall(function() return row.npc:ConvaiFaceApply(feature) end)
            local status
            pcall(function() status = row.npc:ConvaiFaceStatus() end)
            trace(run, current.label, feature, current.tracks,
                {applied = ok and applied or tostring(applied), unwritable = failed, status = status})
            return
        end
    end
end

function M.skips(entity) return active(entity, 'direct') ~= nil end

convaiFaceTest = M
return M
