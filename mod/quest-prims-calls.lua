-- The CALL primitives of the bond quests (docs/QUEST_PRIMITIVES.md section 10.6, BOND_QUESTS.md 14.3): call-in and call-script. install(R, env) adds the two definitions to R.defs
-- (mod/quest-prims.lua calls it through R.extend) and the native calls they need to env.world (the ones the world adapter does not have yet come from
-- mod/quest-world-calls.lua). Pure: every native call goes through env.world, so bridge/quest-prims-calls-lua.test.mjs runs all of it on a fake game.
--
-- A call is the pack's `calls.<id>` as the bridge puts it in the play file (ctx.calls): {caller, picture, text?, onHangUp?, steps}. Its steps are played through the line player
-- (env.lines, mod/quest-lines.lua): {say = lineId} a scripted line of the channel holocall, {gap = gapId} opens the talk gap and the call waits for it to end, {event = name}
-- raises the event, {hangup = true} ends the call. Nothing here runs per frame and nothing ticks faster than the primitive's 1 s: the steps move on events (a line done, a gap
-- resumed) and the tick only watches the ring, the gap and the call's end.
--
--   call-in      call:<id>:ringing, :answered, :done, :hung-up (then the call's onHangUp event), :missed (rang out), :texted (the text went out)
--   call-script  call:<id>:answered, :done, :hung-up                                       plays when V's own call to the character connects (holocall.lua onCallStarted)
--
-- call-in: when no call, scene, quest dialogue, fight or talk is on (the line player's rule, convaiQuestLineBusy) and no other quest call plays, the character rings V for
-- ringSeconds (default 30). Picked up: the steps play. Not picked up, or the game cannot start the call: the call's `text` line (else its first line) goes out as a Phone Chat
-- message from the character, with the pack's own words (nothing is added: a pack that wants "call me" says it in the line), call:<id>:texted, and the same steps play when V
-- calls her (the call-script behaviour). spec.text = false sends no message.
-- call-script: waits for V's call to the character, then plays the steps. The line is a call line (opts.call) of the line player, spoken on the call, never in person.
-- One call at a time (R.calls.running). After the last step the call ends (a short pause after her last word), and call:<id>:done is raised. V hanging up, or any other end of
-- the call, while it plays is call:<id>:hung-up. A call-in call is hung up with its ctx, a call of V's own is only left (it goes on as a talk).
--
-- UNVERIFIED in the game: the ring itself (see mod/quest-world-calls.lua), the pick-up by the phone button, a line spoken on a call by the line player.
local M = {RING_SECONDS = 30, START_DELAY = 1, END_DELAY = 1.5, MAX_STEPS = 24}

local function eventId(value, default)
    if type(value) == 'string' and #value > 0 and #value <= 60 and value:match('^[%w][%w%.%-_]*$') then return value end
    return default
end
local function eventName(value) return type(value) == 'string' and #value > 0 and #value <= 120 and value:match('^[%w][%w:%-_%.]*$') ~= nil end

function M.install(R, env)
    env.world = env.world or {}
    local world0 = env.world

    local function log(line) if type(env.log) == 'function' then pcall(env.log, 'Quest primitive: ' .. line) end end
    local logged = {}
    local function logOnce(key, line)
        if logged[key] then return end
        logged[key] = true
        log(line)
    end
    local function clock()
        local ok, value = pcall(env.clock or os.clock)
        return ok and type(value) == 'number' and value or os.clock()
    end
    local function world(name, ...)
        local fn = env.world[name]
        if type(fn) ~= 'function' then return nil end
        local ok, a, b = pcall(fn, ...)
        if not ok then return nil end
        return a, b
    end

    -- ---- the native calls -------------------------------------------------------------------------------------------------------------------
    -- Whatever the game adapter does not have yet comes from mod/quest-world-calls.lua. A world that already has a function by that name (a test's fake) keeps it. If the file
    -- cannot be loaded the primitives still arm and every call answers nothing: a call-in then sends its text, a call-script never hears a call.
    local natives = env.callNatives
    if natives == nil and type(dofile) == 'function' then
        local ok, module = pcall(dofile, 'quest-world-calls.lua')
        if ok and type(module) == 'table' and type(module.new) == 'function' then
            local built, W = pcall(module.new, {log = env.log})
            if built then natives = W end
        end
    end
    if type(natives) == 'table' then
        for name, fn in pairs(natives) do
            if type(fn) == 'function' and world0[name] == nil then world0[name] = fn end
        end
    end

    -- ---- the registry of the calls ------------------------------------------------------------------------------------------------------------
    -- running: the instance that owns the call now (one at a time). watchers: instances that wait for V's own call to their character (a call-script, or a call-in whose text went out),
    -- in arming order. The hook on holocall.lua is set while there is a watcher and taken away with the last one.
    local C = {running = nil, watchers = {}, unhook = nil}
    R.calls = C

    local function lines() return type(env.lines) == 'table' and env.lines or nil end

    local function setRunning(inst)
        C.running = inst
        world('callLines', true)
    end
    local function release(inst)
        if C.running == inst then
            C.running = nil
            world('callLines', false)
        end
    end

    local runNext, begin

    local function onStarted(profileKey, call)
        if type(call) == 'table' and call.quest == true then return end
        if C.running ~= nil then return end
        for _, inst in ipairs(C.watchers) do
            if not inst.ctx.reaped and inst.character == profileKey then
                local serial = type(call) == 'table' and call.serial or nil
                inst.owned = false
                begin(inst, serial)
                return
            end
        end
    end

    local function watch(inst)
        for _, other in ipairs(C.watchers) do if other == inst then return end end
        C.watchers[#C.watchers + 1] = inst
        if #C.watchers == 1 and C.unhook == nil then
            C.unhook = world('callHook', onStarted)
            if C.unhook == nil then logOnce('call-hook', 'call: V\'s own call cannot be heard, a scripted call only plays when the character calls V') end
        end
    end
    local function unwatch(inst)
        for index = #C.watchers, 1, -1 do if C.watchers[index] == inst then table.remove(C.watchers, index) end end
        if #C.watchers == 0 and C.unhook ~= nil then
            local unhook = C.unhook
            C.unhook = nil
            pcall(unhook)
        end
    end

    -- ---- the steps -----------------------------------------------------------------------------------------------------------------------------
    local function alive(inst) return inst.phase == 'playing' and not inst.ctx.reaped end

    -- Runs steps until one has to wait (a line, a gap) or the call is over.
    function runNext(inst)
        local guard = 0
        while alive(inst) and guard < M.MAX_STEPS + 2 do
            guard = guard + 1
            local step = inst.call.steps[inst.idx]
            if step == nil then
                inst.finish(false)
                return
            end
            inst.idx = inst.idx + 1
            local L = lines()
            if type(step) ~= 'table' then
                -- a malformed step is skipped
            elseif type(step.say) == 'string' then
                if L and L.say(inst.ctx.pack, step.say, {call = function() return alive(inst) end, channel = 'holocall'}) then
                    inst.waitLine = step.say
                    return
                end
                logOnce('call-say:' .. inst.ctx.pack .. step.say, 'call ' .. inst.id .. ': the line ' .. step.say .. ' cannot be played, skipped')
            elseif type(step.gap) == 'string' then
                if L and L.openGap(inst.ctx.pack, step.gap) then
                    inst.waitGap = step.gap
                    return
                end
                logOnce('call-gap:' .. inst.ctx.pack .. step.gap, 'call ' .. inst.id .. ': the gap ' .. step.gap .. ' cannot be opened, skipped')
            elseif type(step.event) == 'string' then
                if eventName(step.event) then inst.ctx:emit(step.event) end
            elseif step.hangup == true then
                inst.finish(true)
                return
            end
        end
    end

    -- The call is on and the steps start (after a short pause: the pick-up, then her first word).
    function begin(inst, serial)
        if inst.phase == 'over' or inst.ctx.reaped then return end
        inst.serial, inst.phase, inst.idx = serial, 'playing', 1
        unwatch(inst)
        setRunning(inst)
        inst.ctx:emit('call:' .. inst.id .. ':answered')
        inst.ctx:after(M.START_DELAY, function() if alive(inst) then runNext(inst) end end, {real = true})
    end

    local function firstSay(call)
        for _, step in ipairs(call.steps) do if type(step) == 'table' and type(step.say) == 'string' then return step.say end end
        return nil
    end

    -- The call did not happen: the text goes out and the call plays when V calls (the call-script behaviour).
    local function fallback(inst, why)
        release(inst)
        inst.serial = nil
        inst.phase = 'texted'
        log('call ' .. inst.id .. ' did not ring through (' .. tostring(why) .. '), ' .. (inst.sendText and 'the text goes out' or 'no text'))
        local L = lines()
        local sent = false
        local line = inst.call.text or firstSay(inst.call)
        if inst.sendText and L and line then sent = L.text(inst.ctx.pack, line) == true end
        watch(inst)
        if sent then inst.ctx:emit('call:' .. inst.id .. ':texted') end
    end

    local function hungUp(inst, reason)
        if inst.phase ~= 'playing' then return end
        inst.phase = 'over'
        local L = lines()
        if L then L.dropCall(inst.ctx.pack) end
        release(inst)
        log('call ' .. inst.id .. ' ended before its last step (' .. tostring(reason) .. ')')
        inst.ctx:emit('call:' .. inst.id .. ':hung-up')
        if inst.onHangUp then inst.ctx:emit(inst.onHangUp) end
    end

    local function missed(inst, why)
        if C.running == inst then C.running = nil end
        inst.ctx:emit('call:' .. inst.id .. ':missed')
        if not inst.ctx.reaped then fallback(inst, why) end
    end

    -- ---- the instance ---------------------------------------------------------------------------------------------------------------------------
    local function newInstance(ctx, spec, kind)
        local id = eventId(spec.id, nil)
        local callId = type(spec.call) == 'string' and spec.call or nil
        if not id or not callId then log(kind .. ' needs an id and a call'); return nil end
        local call = type(ctx.calls) == 'table' and ctx.calls[callId] or nil
        if type(call) ~= 'table' or type(call.steps) ~= 'table' or #call.steps == 0 or #call.steps > M.MAX_STEPS then
            log(kind .. ' ' .. id .. ': the call ' .. callId .. ' is not in the stage')
            return nil
        end
        if not lines() then log(kind .. ' ' .. id .. ': there is no line player'); return nil end
        local inst = {ctx = ctx, kind = kind, id = id, callId = callId, call = call, character = ctx.character, phase = kind == 'call-in' and 'waiting' or 'listening',
            idx = 1, owned = false, sendText = spec.text ~= false, ringSeconds = (type(spec.ringSeconds) == 'number' and spec.ringSeconds >= 5 and spec.ringSeconds <= 120)
                and spec.ringSeconds or M.RING_SECONDS, onHangUp = eventName(call.onHangUp) and call.onHangUp or nil}
        -- The moves of the steps: a line heard to its end, a gap that resumed.
        function inst.finish(now)
            if inst.phase ~= 'playing' then return end
            inst.phase = 'over'
            local L = lines()
            if L then L.dropCall(ctx.pack) end
            ctx:emit('call:' .. id .. ':done')
            local function hangUp()
                if inst.serial ~= nil then world('callEnd', inst.serial, 'scripted') end
                release(inst)
            end
            if now or ctx.reaped then hangUp() else ctx:after(M.END_DELAY, hangUp, {real = true}) end
        end
        -- What both watch while the steps play (the primitive's tick calls it): the call's end, and a gap that ended without its resume event (a tag read from V's words).
        function inst.tickPlaying()
            local state, reason = world('callState', inst.serial)
            if state == 'ended' then hungUp(inst, reason); return end
            if inst.waitGap then
                local L = lines()
                local open = L and L.gap(ctx.pack) or nil
                if not open or open.id ~= inst.waitGap then inst.waitGap = nil; runNext(inst) end
            end
        end
        local seenLine, seenGap = {}, {}
        for _, step in ipairs(call.steps) do
            if type(step) == 'table' and type(step.say) == 'string' and eventName('line:' .. step.say .. ':done') and not seenLine[step.say] then
                seenLine[step.say] = true
                local line = step.say
                ctx:on('line:' .. line .. ':done', function()
                    if alive(inst) and inst.waitLine == line then inst.waitLine = nil; runNext(inst) end
                end)
            elseif type(step) == 'table' and type(step.gap) == 'string' and eventName('gap:' .. step.gap .. ':resume') and not seenGap[step.gap] then
                seenGap[step.gap] = true
                local gap = step.gap
                ctx:on('gap:' .. gap .. ':resume', function()
                    if alive(inst) and inst.waitGap == gap then inst.waitGap = nil; runNext(inst) end
                end)
            end
        end
        return inst
    end

    local function disarm(ctx, spec, inst)
        if not inst then return end
        local was = inst.phase
        inst.phase = 'over'
        local L = lines()
        if L then L.dropCall(ctx.pack) end
        -- A call the quest started is hung up with its ctx (a ring too), V's own call is only left.
        if inst.owned and inst.serial ~= nil then world('callEnd', inst.serial, 'scripted') end
        unwatch(inst)
        release(inst)
        if was == 'playing' then logOnce('call-reap:' .. ctx.pack .. inst.id, 'call ' .. inst.id .. ' was cut by the end of its stage') end
    end

    -- ---- call-in --------------------------------------------------------------------------------------------------------------------------------
    R.defs['call-in'] = {
        interval = 1,
        arm = function(ctx, spec) return newInstance(ctx, spec, 'call-in') end,
        tick = function(ctx, spec, inst)
            local phase = inst.phase
            if phase == 'waiting' then
                -- Only at a calm moment, and only when no other quest call plays. The line player's rule is read once a second while the call waits.
                if C.running ~= nil or world('callBusy') ~= false then return end
                local serial, why = world('callRing', ctx.character, {voice = inst.call.picture == 'voice'})
                if serial == nil or serial == false then
                    log('call ' .. inst.id .. ' cannot ring: ' .. tostring(why or 'the game cannot start a call'))
                    fallback(inst, why or 'cannot ring')
                    return
                end
                inst.serial, inst.owned, inst.phase, inst.ringAt = serial, true, 'ringing', clock()
                C.running = inst
                ctx:emit('call:' .. inst.id .. ':ringing')
            elseif phase == 'ringing' then
                local state = world('callState', inst.serial)
                if state == 'connected' then
                    begin(inst, inst.serial)
                elseif state == 'ringing' then
                    if clock() - inst.ringAt >= inst.ringSeconds then
                        world('callEnd', inst.serial, 'scripted')
                        missed(inst, 'not picked up')
                    end
                else
                    missed(inst, 'the ring ended')
                end
            elseif phase == 'playing' then
                inst.tickPlaying()
            end
        end,
        disarm = disarm,
    }

    -- ---- call-script ----------------------------------------------------------------------------------------------------------------------------
    R.defs['call-script'] = {
        interval = 1,
        arm = function(ctx, spec)
            local inst = newInstance(ctx, spec, 'call-script')
            if inst then watch(inst) end
            return inst
        end,
        tick = function(ctx, spec, inst)
            if inst.phase == 'playing' then inst.tickPlaying() end
        end,
        disarm = disarm,
    }

    function C.status()
        local rows = {}
        for _, inst in ipairs(C.watchers) do rows[#rows + 1] = {pack = inst.ctx.pack, id = inst.id, phase = inst.phase} end
        return {running = C.running and {pack = C.running.ctx.pack, id = C.running.id, phase = C.running.phase} or nil, watchers = rows}
    end
end

return M
