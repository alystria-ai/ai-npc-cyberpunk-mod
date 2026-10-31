-- Romance animations (docs/ROMANCE_ANIMATIONS.md): a kiss, a hug, holding hands, sitting together, a cuddle or lying together between V and a
-- romance partner, played with the game's own two person workspots on the invisible device the body gestures already use.
--
-- Everything happens on a request. Idle, tick() returns at the first check. The only other state is a short armed window after a private talk
-- turn with a partner, in which the bridge's request file is read once a second. While a pair plays, a watch runs every half second (two reads of
-- "is she still in the workspot" and the gates again). Nothing runs per frame.
--
-- The flow, one request at a time:
--   request(entry, kind, source)  gates it, chooses a row of mod/romance-pairs.lua for the two rigs (or a fallback kind), asks V once
--   answer(yes)                   gates again, blinks, then after the blink:
--   enter                         spawns the device at V, checks both components exist, enters V and her in the same call (PlayInDeviceSimple),
--                                 jumps to each half's entry when the row names one, and checks after a moment that both are inside. If the
--                                 roots do not line up at the workspot's own position, the row is entered again with the offset table.
--   playing                       holds for the row's time, re-jumps both together when the row loops, ends early on danger, a reply that must be
--                                 heard, V's "stop", a half that left the workspot, or the world changing
--   exit                          blink, SendFastExitSignal then StopInDevice on both, delete the device, put V (and her) back where they stood
-- A row that fails (a path or an entry the game does not have) is skipped for the session, logged in Developer mode, and the next choice is
-- tried: another row of the kind, then the fallback kinds (sit together, hold hands).
local M = {version = 1}

M.policy = {
    blinkLead = 0.45,     -- seconds from the first blink to the entry, and from the exit blink to the exit signals
    confirmWait = 120,    -- the question is dropped after this long unanswered (the box stays up that long; mod/init.lua gives up at 150)
    deviceWait = 3,       -- the device must exist this long after the spawn call
    verifyAfter = 1.2,    -- both must be in the workspot this long after the entry
    watchEvery = 0.5,     -- seconds between two checks while a pair plays
    exitWait = 1.6,       -- seconds after the exit signals before the force stop
    cooldown = 4,         -- no new request this long after one ended
    reach = 4.0,          -- the partner must be this close to V (metres) to be asked
    gapMin = 0.15, gapMax = 2.4,   -- at the workspot's own position the two must end up between these distances apart
    replyGrace = 1.5,     -- a short pair plays at least this long before a reply may end it
    armSeconds = 90,      -- after a private turn with a partner the request file is read for this long
    pollEvery = 1.0,
    attempts = 3,         -- rows tried for one request
    speakWait = 25,       -- a request made while she speaks waits this long for the reply to end
}
M.KINDS = {'kiss', 'hug', 'hands', 'sit', 'cuddle', 'lie'}
M.REQUESTS = 'runtime/romance-anim.json'

local function isKind(kind)
    for _, known in ipairs(M.KINDS) do if known == kind then return true end end
    return false
end
M.isKind = isKind

local function has(list, value)
    if type(list) ~= 'table' then return false end
    for _, item in ipairs(list) do if item == value then return true end end
    return false
end

-- ---- the pair table ---------------------------------------------------------------------------------------------------------------------
-- A row can be offered when both halves name a workspot, it is not marked offer = false, the two rigs and the character fit, and what it
-- assumes around it (a seat, a bed) is confirmed. ctx = {vRig, npcRig, profileKey, supports(need) -> bool, failed = {[id] = true}}.
function M.usable(row, ctx)
    if type(row) ~= 'table' or row.offer == false or (ctx.failed and ctx.failed[row.id]) then return false end
    if type(row.v) ~= 'table' or type(row.n) ~= 'table' then return false end
    if type(row.v.workspot) ~= 'string' or type(row.n.workspot) ~= 'string' then return false end
    if not has(row.vRigs, ctx.vRig) or not has(row.npcRigs, ctx.npcRig) then return false end
    if row.characters ~= nil and not has(row.characters, ctx.profileKey) then return false end
    if row.needs ~= nil and not (type(ctx.supports) == 'function' and ctx.supports(row.needs) == true) then return false end
    return true
end

-- The best row of one kind: a checked row before a candidate, a row made for this character before a general one, then table order.
function M.best(data, kind, ctx)
    local best, bestScore
    for index, row in ipairs(data.rows or {}) do
        if row.kind == kind and M.usable(row, ctx) then
            local score = (row.verified == true and 2000 or 0) + (row.characters ~= nil and 1000 or 0) - index
            if bestScore == nil or score > bestScore then best, bestScore = row, score end
        end
    end
    return best
end

-- row, kind, askedKind: the best row of the asked kind, or of the first fallback kind that has one. nil when none fits these two rigs.
function M.choose(data, kind, ctx)
    local row = M.best(data, kind, ctx)
    if row then return row, kind, kind end
    for _, other in ipairs((data.fallback or {})[kind] or {}) do
        row = M.best(data, other, ctx)
        if row then return row, other, kind end
    end
    return nil
end

-- Where the partner stands for an offset row: `offset` ({forward, right, yaw}) from V's pose (yaw in degrees, the game's: forward is (-sin, cos)).
function M.place(pose, offset)
    local yaw = math.rad(pose.yaw or 0)
    local forward, right = offset.forward or 0, offset.right or 0
    return {x = pose.x - math.sin(yaw) * forward + math.cos(yaw) * right,
            y = pose.y + math.cos(yaw) * forward + math.sin(yaw) * right,
            z = pose.z, yaw = ((pose.yaw or 0) + (offset.yaw or 0) + 180) % 360 - 180}
end

local function flat(a, b)
    local dx, dy = a.x - b.x, a.y - b.y
    return math.sqrt(dx * dx + dy * dy)
end

-- ---- the controller ---------------------------------------------------------------------------------------------------------------------
-- options: enabled() -> bool; player() -> V; resolve(profileKey) -> entry | nil (one of V's own copies: .npc .serial .profileKey .name);
--   partner(profileKey) -> bool (together with V); rigOf(entry) -> 'woman_base' | 'man_base' | 'man_big' | nil; template() -> the device .ent path;
--   blocked(entry) -> nil | reason (combat, driving, mission, scene, cutscene, menu, call, speaking), asked before a pair starts;
--   danger(entry) -> nil | reason (combat, a call), asked while it plays; speaking(entry) -> bool (a reply is playing for her);
--   confirm(info, answer) -> bool (shows the question; answer(true|false) comes later; false: it could not be shown);
--   supports(need) -> bool; yield(entry) lets the other body owners (gestures, seating) go of her; notice(text); log(kind, fields);
--   read(path) -> text; decode(text) -> table; clock() -> seconds; data (the pair table, default mod/romance-pairs.lua); native (gesture-workspot).
function M.new(options)
    options = options or {}
    local self = {policy = {}}
    for key, value in pairs(M.policy) do self.policy[key] = value end
    local policy = self.policy
    local native = options.native or dofile('gesture-workspot.lua')
    local data = options.data or dofile('romance-pairs.lua')
    local function now() return options.clock and options.clock() or os.clock() end
    local function call(fn, ...)
        if type(fn) ~= 'function' then return nil end
        local ok, value, extra = pcall(fn, ...)
        if ok then return value, extra end
        return nil
    end
    local function log(kind, fields)
        if type(options.log) == 'function' then pcall(options.log, kind, fields) end
    end
    local state = {phase = 'idle'}      -- the one request in progress
    local failed = {}                   -- row ids that did not work this session
    local placed = {}                   -- row ids whose resource placement did not line up: they use the offset
    local cooldownUntil = 0
    local armedUntil, pollAt, seen = nil, 0, nil

    self.failed, self.placedOffset = failed, placed

    local function reset() state = {phase = 'idle'} end
    function self.phase() return state.phase end
    function self.active() return state.phase ~= 'idle' end
    function self.owns(entry) return state.phase ~= 'idle' and state.phase ~= 'confirming' and state.phase ~= 'waiting' and entry ~= nil and state.entry == entry end
    function self.snapshot()
        return {phase = state.phase, row = state.row and state.row.id, kind = state.kind, asked = state.asked, mode = state.mode,
            profileKey = state.entry and state.entry.profileKey, failed = failed}
    end

    -- ---- gates -------------------------------------------------------------------------------------------------------------------------
    -- nil when a pair may be asked for, else why not. Called when asked, when answered, and while it plays (never per frame).
    local function gate(entry, quick)
        if type(options.enabled) == 'function' and options.enabled() ~= true then return 'off' end
        if entry == nil or entry.npc == nil then return 'no-partner' end
        if type(options.partner) ~= 'function' or options.partner(entry.profileKey) ~= true then return 'not-partner' end
        local player = options.player and options.player()
        if player == nil then return 'no-player' end
        -- While a pair plays, V is in a workspot and the scene flags are the workspot's own: only real danger ends it (options.danger).
        local check = quick and options.danger or options.blocked
        local reason = type(check) == 'function' and check(entry) or nil
        if reason then return reason end
        if quick then return nil end
        local inside = native.inWorkspot and native.inWorkspot(player)
        if inside == true then return 'v-busy' end
        local him = native.inWorkspot and native.inWorkspot(entry.npc)
        if him == true and not (state.entry == entry and state.phase ~= 'idle') then return 'partner-busy' end
        local a, b = native.pose and native.pose(player), native.pose and native.pose(entry.npc)
        if a == nil or b == nil then return 'no-pose' end
        if flat(a, b) > policy.reach then return 'far' end
        return nil
    end
    self.gate = gate

    -- ---- the end of anything --------------------------------------------------------------------------------------------------------
    -- Idempotent: clean exit from any phase. Signals both out, force stops, deletes the device and puts V and the partner back.
    local function finish(reason, quiet)
        local s = state
        if s.phase == 'idle' then return end
        local player = options.player and options.player()
        local npc = s.entry and s.entry.npc
        local entered = s.entered
        if entered then
            if player then call(native.exit, player) end
            if npc then call(native.exit, npc) end
            if player then call(native.stopInDevice, player) end
            if npc then call(native.stopInDevice, npc) end
        end
        if s.deviceId ~= nil then call(native.deleteDevice, s.deviceId) end
        if entered or s.moved then
            if player and s.vPose then call(native.teleport, player, s.vPose, s.vPose.yaw) end
            if npc and s.npcPose then call(native.teleport, npc, s.npcPose, s.npcPose.yaw) end
        end
        if s.blinked and player and not quiet then call(native.blink, player) end
        log('end', {reason = reason, row = s.row and s.row.id, kind = s.kind, seconds = s.playingSince and now() - s.playingSince or 0})
        cooldownUntil = now() + policy.cooldown
        reset()
    end
    self.finish = finish

    -- ---- choosing -----------------------------------------------------------------------------------------------------------------------
    local function context(entry)
        local player = options.player and options.player()
        return {vRig = player and native.playerRig and native.playerRig(player) or nil,
            npcRig = type(options.rigOf) == 'function' and options.rigOf(entry) or nil,
            profileKey = entry.profileKey, failed = failed,
            supports = options.supports}
    end

    function self.offerFor(entry, kind)
        if not isKind(kind) then return nil, 'unknown-kind' end
        local ctx = context(entry)
        if ctx.vRig == nil or ctx.npcRig == nil then return nil, 'rig-unknown' end
        local row, used, asked = M.choose(data, kind, ctx)
        if not row then return nil, 'no-pair' end
        return {row = row, kind = used, asked = asked, fellBack = used ~= asked}
    end

    -- ---- request, question, answer -----------------------------------------------------------------------------------------------------
    -- ok, info|reason. source: 'talk' or 'list' (for the log only).
    function self.request(entry, kind, source)
        local t = now()
        if state.phase ~= 'idle' then return false, 'busy' end
        if t < cooldownUntil then return false, 'cooldown' end
        local reason = gate(entry)
        if reason == 'speaking' then
            -- Her reply is still playing: the question waits for it to end (her speech is never cut for a pair), for a little while.
            state = {phase = 'waiting', entry = entry, kind = kind, source = source, until_ = t + policy.speakWait}
            return true, 'waiting'
        end
        if reason then log('refused', {reason = reason, kind = kind, source = source}); return false, reason end
        local offer, why = self.offerFor(entry, kind)
        if not offer then log('refused', {reason = why, kind = kind, source = source}); return false, why end
        if type(options.confirm) ~= 'function' then return false, 'no-confirm' end
        state = {phase = 'confirming', entry = entry, row = offer.row, kind = offer.kind, asked = offer.asked, source = source,
            until_ = t + policy.confirmWait, attempts = 0}
        local info = {name = entry.name or entry.profileName or entry.profileKey, kind = offer.kind, asked = offer.asked, fellBack = offer.fellBack, row = offer.row.id}
        local shown = call(options.confirm, info, function(yes) self.answer(yes == true) end)
        if shown ~= true then reset(); return false, 'no-confirm' end
        log('asked', {row = offer.row.id, kind = offer.kind, asked = offer.asked, source = source})
        return true, info
    end

    function self.answer(yes)
        if state.phase ~= 'confirming' then return false end
        if not yes then log('declined', {row = state.row.id}); reset(); return false end
        local reason = gate(state.entry)
        if reason then
            log('refused', {reason = reason, at = 'answer'})
            if type(options.notice) == 'function' then call(options.notice, 'not-now:' .. reason) end
            reset()
            return false
        end
        local player = options.player()
        state.vPose = native.pose(player)
        state.npcPose = native.pose(state.entry.npc)
        if not state.vPose or not state.npcPose then reset(); return false end
        call(options.yield, state.entry)
        state.phase = 'blink'
        state.at = now() + policy.blinkLead
        state.blinked = true
        call(native.blink, player)
        return true
    end

    -- A pair stops now (V asked, or the action list): a pair in the question is dropped, one that plays is exited.
    function self.stop(reason)
        if state.phase == 'idle' then return false end
        if state.phase == 'confirming' or state.phase == 'waiting' then reset(); return true end
        if state.phase == 'playing' or state.phase == 'verify' or state.phase == 'device' or state.phase == 'blink' or state.phase == 'enter' then
            state.exitReason = reason or 'stop'
            state.phase = 'exiting'
            state.at = now()
            return true
        end
        return false
    end

    -- ---- the entry --------------------------------------------------------------------------------------------------------------------
    local function componentOf(row, half) return 'convai_romance_' .. row.id .. '_' .. half end

    local function nextRow(reason)
        -- This row did not work: it is skipped for the session and the next choice (same kind, then the fallbacks) is entered.
        local row = state.row
        failed[row.id] = true
        log('row-failed', {row = row.id, reason = reason})
        state.attempts = (state.attempts or 0) + 1
        local entry = state.entry
        local keep = {vPose = state.vPose, npcPose = state.npcPose, blinked = state.blinked, attempts = state.attempts, source = state.source, asked = state.asked, moved = true}
        -- Leave whatever entered, then choose again.
        local player = options.player()
        if state.entered then
            call(native.exit, player); call(native.exit, entry.npc)
            call(native.stopInDevice, player); call(native.stopInDevice, entry.npc)
        end
        if state.deviceId ~= nil then call(native.deleteDevice, state.deviceId) end
        local offer = state.attempts < policy.attempts and self.offerFor(entry, state.asked) or nil
        if not offer then
            state = keep; state.phase = 'exiting'; state.entry = entry; state.exitReason = 'no-row'; state.at = now()
            state.noRow = true
            return
        end
        state = keep
        state.entry, state.row, state.kind, state.phase, state.at = entry, offer.row, offer.kind, 'enter', now()
    end

    local function enter()
        local player, entry, row = options.player(), state.entry, state.row
        if state.deviceId == nil then
            local template = type(options.template) == 'function' and options.template() or nil
            if not template then return nextRow('no-device-template') end
            local ok, id = native.spawnDevice(player, template)
            if not ok or id == nil then return nextRow('device-not-spawned') end
            state.deviceId, state.deviceAt, state.phase = id, now(), 'device'
            return
        end
    end

    local function play()
        local player, entry, row = options.player(), state.entry, state.row
        local device = native.deviceEntity(state.deviceId)
        if device == nil then
            if now() - state.deviceAt > policy.deviceWait then return nextRow('device-missing') end
            return
        end
        if device == false then return nextRow('device-error') end
        local okV, haveV = native.hasComponent(device, componentOf(row, 'v'))
        local okN, haveN = native.hasComponent(device, componentOf(row, 'n'))
        if not (okV and haveV == true and okN and haveN == true) then return nextRow('component-missing') end
        local mode = (placed[row.id] or row.placement == 'offset') and 'offset' or 'resource'
        state.mode = mode
        if mode == 'offset' then
            local spot = M.place(state.vPose, row.offset or {forward = 0.7, right = 0, yaw = 180})
            call(native.teleport, entry.npc, spot, spot.yaw)
            state.moved = true
        end
        -- Both in the same call, so their clocks start together.
        local a = native.playSimple(device, player, componentOf(row, 'v'), mode)
        local b = native.playSimple(device, entry.npc, componentOf(row, 'n'), mode)
        state.entered = true
        if not (a and b) then return nextRow('play-refused') end
        if row.v.jump and row.n.jump then
            native.jump(player, row.v.jump, false)
            native.jump(entry.npc, row.n.jump, false)
        end
        state.phase, state.at = 'verify', now() + policy.verifyAfter
        state.startedAt = now()
        log('entered', {row = row.id, mode = mode, kind = state.kind})
    end

    local function verify()
        local player, entry, row = options.player(), state.entry, state.row
        local a, b = native.inWorkspot(player), native.inWorkspot(entry.npc)
        if a ~= true or b ~= true then return nextRow('not-entered') end
        if state.mode == 'resource' then
            local pa, pb = native.pose(player), native.pose(entry.npc)
            local gap = pa and pb and flat(pa, pb) or nil
            if gap == nil or gap < policy.gapMin or gap > policy.gapMax then
                -- The two roots do not line up at the workspot's own position: this row uses the offset table from now on and is entered again.
                placed[row.id] = true
                log('placement', {row = row.id, gap = gap, next = 'offset'})
                call(native.exit, player); call(native.exit, entry.npc)
                call(native.stopInDevice, player); call(native.stopInDevice, entry.npc)
                if state.deviceId ~= nil then call(native.deleteDevice, state.deviceId) end
                call(native.teleport, player, state.vPose, state.vPose.yaw)
                call(native.teleport, entry.npc, state.npcPose, state.npcPose.yaw)
                state.entered, state.deviceId = nil, nil
                state.phase, state.at = 'enter', now() + 0.3
                return
            end
        end
        state.phase, state.playingSince = 'playing', now()
        local hold = tonumber(row.hold) or (data.holdDefault or {})[state.kind] or 30
        state.endsAt = now() + hold
        state.nextWatch = now() + policy.watchEvery
        if row.loopEvery and row.v.jump and row.n.jump then state.nextLoop = now() + row.loopEvery end
    end

    local function watch()
        local t, player, entry, row = now(), options.player(), state.entry, state.row
        if t < state.nextWatch then return end
        state.nextWatch = t + policy.watchEvery
        local reason = gate(entry, true)
        if reason then state.exitReason, state.phase, state.at = 'danger:' .. reason, 'exiting', t; return end
        if native.inWorkspot(player) ~= true or native.inWorkspot(entry.npc) ~= true then
            -- One of them was taken out of the workspot (the game, a hit): the other is brought out at once and both are put back.
            state.exitReason, state.phase, state.at = 'left', 'exiting', t; return
        end
        if row.speech == 'hold' and type(options.speaking) == 'function' and t - state.playingSince >= policy.replyGrace and options.speaking(entry) == true then
            state.exitReason, state.phase, state.at = 'reply', 'exiting', t; return
        end
        if state.nextLoop and t >= state.nextLoop then
            state.nextLoop = t + row.loopEvery
            native.jump(player, row.v.jump, false)
            native.jump(entry.npc, row.n.jump, false)
        end
        if t >= state.endsAt then state.exitReason, state.phase, state.at = 'done', 'exiting', t end
    end

    local function leave()
        local player, entry = options.player(), state.entry
        if not state.exiting then
            state.exiting = true
            if player and state.blinked then call(native.blink, player) end
            state.at = now() + policy.blinkLead
            return
        end
        if now() < state.at then return end
        -- The exit signals first, the force stop after a moment, then the device goes and V and she are put back.
        if not state.signalled then
            state.signalled = true
            if player then call(native.exit, player) end
            call(native.exit, entry.npc)
            state.stopAt = now() + policy.exitWait
            return
        end
        if now() < state.stopAt then
            local a, b = native.inWorkspot(player), native.inWorkspot(entry.npc)
            if a ~= false or b ~= false then return end
        end
        state.blinked = false
        finish(state.exitReason or 'done', true)
        if state.phase ~= 'idle' then reset() end
    end

    -- ---- the talk channel -----------------------------------------------------------------------------------------------------------
    -- A private turn with a partner arms the request file for a while. The bridge writes {revision, requests = [{id, profileKey, kind}]}.
    local function readRequests()
        if type(options.read) ~= 'function' or type(options.decode) ~= 'function' then return nil end
        local text = call(options.read, M.REQUESTS)
        if type(text) ~= 'string' or text == '' then return nil end
        local value = call(options.decode, text)
        if type(value) ~= 'table' or type(value.requests) ~= 'table' then return nil end
        return value
    end

    function self.arm()
        if type(options.enabled) == 'function' and options.enabled() ~= true then return end
        armedUntil, pollAt = now() + policy.armSeconds, 0
        if seen == nil then
            local value = readRequests()
            seen = 0
            if value then for _, request in ipairs(value.requests) do if type(request.id) == 'number' and request.id > seen then seen = request.id end end end
        end
    end
    function self.armed() return armedUntil ~= nil end

    local function poll()
        local t = now()
        if t > armedUntil then armedUntil = nil; return end
        if t < pollAt then return end
        pollAt = t + policy.pollEvery
        local value = readRequests()
        if not value then return end
        local newest = seen or 0
        for _, request in ipairs(value.requests) do
            if type(request) == 'table' and type(request.id) == 'number' and request.id > (seen or 0) then
                if request.id > newest then newest = request.id end
                local entry = type(options.resolve) == 'function' and call(options.resolve, request.profileKey) or nil
                if request.kind == 'stop' then
                    if state.entry and state.entry == entry then self.stop('asked') end
                elseif isKind(request.kind) and entry then
                    self.request(entry, request.kind, 'talk')
                end
            end
        end
        seen = newest
    end

    -- ---- the tick -----------------------------------------------------------------------------------------------------------------------
    -- From the party tick. Idle and not armed: two comparisons.
    function self.tick()
        if armedUntil then poll() end
        local phase = state.phase
        if phase == 'idle' then return end
        local t = now()
        local entry = state.entry
        if entry == nil or entry.npc == nil or options.player() == nil then finish('gone', true); return end
        if phase == 'confirming' then
            if t > state.until_ then reset() end
            return
        end
        if phase == 'waiting' then
            if t > state.until_ then log('refused', {reason = 'speaking', at = 'wait'}); reset(); return end
            if gate(entry) ~= 'speaking' then
                local kind, source = state.kind, state.source
                reset()
                self.request(entry, kind, source)
            end
            return
        end
        if phase == 'blink' then
            if t >= state.at then
                local reason = gate(entry)
                if reason then
                    log('refused', {reason = reason, at = 'enter'})
                    finish('gate:' .. reason, true)
                    return
                end
                state.phase = 'enter'
                enter()
            end
        elseif phase == 'enter' then
            if t >= (state.at or 0) then enter() end
        elseif phase == 'device' then play()
        elseif phase == 'verify' then if t >= state.at then verify() end
        elseif phase == 'playing' then
            watch()
        elseif phase == 'exiting' then leave() end
    end

    -- The world ended, or V fast travelled: no native calls (the device is not persistent).
    function self.abandon(reason)
        if state.phase ~= 'idle' then log('abandoned', {reason = reason}) end
        reset(); armedUntil = nil; seen = nil
    end
    -- The partner went (dismissed, sent home, fast travel): leave cleanly.
    function self.release(entry, reason)
        if state.entry == entry and state.phase ~= 'idle' then
            if state.phase == 'confirming' or state.phase == 'waiting' then reset() else finish('released:' .. tostring(reason)) end
        end
    end
    function self.observe(entry)
        return self.owns(entry)
    end

    return self
end

return M
