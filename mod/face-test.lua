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
    'eye_l_brows_lower','eye_r_brows_lower'}
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

local function step(run)
    return run.steps[math.min(#run.steps, math.floor(run.elapsed / run.per) + 1)]
end

-- Called once per frame from the facial writer's frame start.
function M.poll(delta, context)
    delta = (type(delta) == 'number' and delta == delta and delta > 0 and delta < .5) and delta or 0
    M.clock = M.clock + delta
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
    M.pollAt = M.clock + .25
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
function M.pre(entity, slot, clock)
    local run = active(entity, 'policy')
    if not run then return end
    local label = policyFamily[step(run).label:match('^[^@]+')] or ({['ramp-smile']='Joy',['ramp-frown']='Sadness',['ramp-brows']='Surprise'})[run.pose]
    if label then
        slot.emotion, slot.scale, slot.expiry, slot.active = label, 3, (clock or 0) + .5, slot.active
        slot.family = label:lower() == 'joy' and 'joy' or label:lower() == 'sadness' and 'sadness'
            or label:lower() == 'surprise' and 'surprise' or 'anger'
    end
end

local function snapshot(feature, run, tracks)
    local written = {}
    for _, name in ipairs(EXPRESSION) do
        local value = feature[name]
        if type(value) == 'number' and value ~= 0 then written[name] = math.floor(value * 1000) / 1000 end
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
        for _, name in ipairs(EXPRESSION) do feature[name] = current.tracks[name] or 0 end
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
