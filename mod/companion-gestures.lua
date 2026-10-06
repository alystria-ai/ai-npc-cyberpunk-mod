-- Companion body gestures (docs/COMPANION_GESTURES.md). While a companion speaks a
-- long enough reply (or listens to V), it enters the talk stance that matches
-- its own idle through an invisible device workspot, plays gesture clips chosen
-- by gesture-selection.lua, and returns to its vanilla idle afterwards. It
-- never touches a copy that is moving, fighting, seated, in a scene, or in a
-- workspot it did not start. Movement waits while the stance is active, the
-- same way it waits for the native holster handoff.
local workspot = dofile('gesture-workspot.lua')
local selection = dofile('gesture-selection.lua')
local M = {}
local HOLDING = {spawning = true, starting = true, active = true, exiting = true, recovering = true}
M.policy = {linger = 2.5, patience = 3, giveUp = 6, unsettled = .8, playerMoved = .75, playerRunning = 2.5,
    nearStart = 4.0, nearKeep = 4.5, socialPhases = {settled = true, attend = true},
    wedgeAfter = 1.5, healthWindow = 10, recoveryHold = .9, recoveryLimit = 2, failureCooldown = 30, minimumSpeech = 5,
    -- Signature idle flavour (characters marked flavour in the catalog only):
    -- after this long settled, now and then, for a short while.
    flavourSettled = 20, flavourFirst = {45, 90}, flavourGap = {60, 150}, flavourLength = {18, 30}}

local function distance(a, b)
    if not a or not b then return 0 end
    return math.sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2)
end
local function copy(p) return p and {x = p.x, y = p.y, z = p.z} end

-- Native guards shared with the holster handoff (companion-equipment.lua).
local function nativeAllowed(npc, player)
    local ok, allowed, reason = pcall(function()
        if not npc:IsOnAutonomousAI() then return false, 'not autonomous' end
        if npc:GetHighLevelStateFromBlackboard() ~= Enum.new('gamedataNPCHighLevelState', 'Relaxed') then return false, 'not relaxed' end
        local scene = Game.GetSceneSystem():GetScriptInterface()
        if PlayerPuppet.GetSceneTier(player) ~= 1 or scene:IsEntityInDialogue(player:GetEntityID())
            or scene:IsEntityInScene(npc:GetEntityID()) or scene:IsEntityInDialogue(npc:GetEntityID()) then
            return false, 'scene or dialogue'
        end
        for _, tag in ipairs({'Injured', 'Defeated', 'Unconscious', 'Stunned', 'Ragdoll'}) do
            if StatusEffectSystem.ObjectHasStatusEffectWithTag(npc, CName.new(tag)) then return false, 'status ' .. tag end
        end
        return true
    end)
    if not ok then return false, 'guard unavailable' end
    return allowed, reason
end

function M.new(options)
    options = options or {}
    local self = {catalog = options.catalog or dofile('gesture-catalog.lua'), states = {}, clock = 0, tickCount = 0,
        enabled = options.enabled or function() return false end,
        speech = options.speech or function() return nil end,
        listening = options.listening or function() return nil end,
        thinking = options.thinking or function() return nil end,
        allowed = options.allowed or nativeAllowed, native = options.native or workspot,
        random = options.random, log = options.log or function() end, errors = {}}
    local native, policy = self.native, M.policy

    -- A family whose workspot is missing from the installed archive (older
    -- archive) is skipped for its fallback after the first failed play.
    self.missingFamilies = self.missingFamilies or {}
    local function familyFor(known, key)
        local family = key and not self.missingFamilies[key] and self.catalog.families and self.catalog.families[key]
        if not family then return nil end
        for _, rig in ipairs(family.rigs) do if rig == known.rig then return family, key end end
        return nil
    end
    local function characterOf(entry)
        local known = self.catalog.characters and self.catalog.characters[entry.record]
        if not known then return nil end
        local family, key = familyFor(known, known.talk)
        if not family then family, key = familyFor(known, known.fallback) end
        if not family then return nil end
        return known, family, key
    end
    local function stateFor(entry)
        local s = self.states[entry.serial]
        if not s then
            s = {serial = entry.serial, phase = 'off', sel = selection.new(self.random), recoveries = {}}
            self.states[entry.serial] = s
        end
        s.entry = entry
        return s
    end
    local function note(s, kind, fields)
        fields = fields or {}; fields.serial, fields.phase = s.serial, s.phase
        s.last = kind
        self.log(kind, fields)
    end
    local function entityOf(entry) return tostring(entry.entityID and entry.entityID.hash or entry.serial) end

    -- What this copy should be doing with its voice right now.
    local function modeFor(s)
        local entity = entityOf(s.entry)
        local speech = self.speech(entity)
        if speech then
            -- The face timeline only knows the current phrase (local voices
            -- stream phrase by phrase), so a phrase end is not the reply end.
            -- Estimate the whole reply from its text (about 2.6 words/s).
            local total = math.max(speech.knownEnd or 0, self.replyEstimate(entity, speech.requestId) or 0)
            if total >= policy.minimumSpeech then
                return 'speaking', {total = total, remaining = math.max(0, total - (speech.at or 0)),
                    family = speech.family, scale = speech.scale, requestId = speech.requestId}
            end
            return 'short', nil
        end
        if self.listening() == entity then return 'listening', {} end
        if self.thinking() == entity then return 'thinking', nil end
        return nil
    end

    self.wordsPerSecond = 2.6
    self.replyText = options.replyText or function(entity, requestId)
        local speech = convaiSpeech
        if type(speech) ~= 'table' or type(speech.text) ~= 'string' then return nil end
        local context = speech.context
        if context and context.entity ~= entity then return nil end
        if requestId and speech.requestId and speech.requestId ~= requestId then return nil end
        return speech.text
    end
    function self.replyEstimate(entity, requestId)
        local ok, text = pcall(self.replyText, entity, requestId)
        if not ok or type(text) ~= 'string' then return nil end
        local words = 0
        for _ in text:gmatch('%S+') do words = words + 1 end
        return words / self.wordsPerSecond
    end

    local function deviceFor(s, npc)
        if s.deviceID then
            local entity = native.deviceEntity(s.deviceID)
            if entity == false then s.deviceID, s.device = nil, nil
            elseif entity then
                if not s.deviceMoved then native.moveDevice(entity, npc); s.deviceMoved = true end
                return entity
            else return nil end
        end
        if not s.deviceID then
            local ok, id = native.spawnDevice(npc, self.catalog.device)
            if not ok then return nil, tostring(id) end
            s.deviceID, s.deviceMoved = id, true
        end
        return nil
    end

    local function between(range) return range[1] + (range[2] - range[1]) * ((self.random or math.random)()) end
    local function begin(s, known, family, recovery, flavour, familyKey)
        s.phase, s.since = recovery and 'recovering' or 'spawning', self.clock
        s.flavour = flavour == true
        s.component = flavour and self.catalog.idleComponents[known.idle] or family.component
        s.flavourUntil = flavour and self.clock + between(policy.flavourLength) or nil
        s.known, s.family, s.rig, s.character, s.familyKey = known, family, known.rig, known.key, familyKey
        s.deviceMoved, s.clip, s.exitAt, s.playerAnchor, s.unsettledSince = false, nil, nil, copy(self.playerPosition), nil
        s.recovery, s.playAt = recovery == true, nil
        note(s, recovery and 'recovery-begin' or (flavour and 'flavour-begin') or 'begin', {family = known.talk, component = s.component})
    end
    local function finish(s, reason)
        note(s, 'finished', {reason = reason, exitLatency = s.exitAt and self.clock - s.exitAt})
        s.phase, s.clip, s.exitAt, s.lingerUntil, s.recovery = 'off', nil, nil, nil, nil
        s.healthFrom, s.wedgedSince = self.clock, nil
    end
    local function fail(s, reason)
        note(s, 'failed', {reason = reason})
        s.phase, s.clip, s.exitAt = 'off', nil, nil
        s.cooldownUntil = self.clock + policy.failureCooldown
        self.errors[#self.errors + 1] = reason
        if #self.errors > 8 then table.remove(self.errors, 1) end
    end
    local function requestExit(s, reason, instant)
        if s.phase == 'spawning' or s.phase == 'starting' then
            -- Not yet in the workspot: a late play must not strand the copy.
            if s.phase == 'starting' and s.entry.npc then native.exit(s.entry.npc, true) end
            finish(s, reason); return
        end
        if s.phase ~= 'active' and s.phase ~= 'recovering' then return end
        s.phase, s.exitAt, s.exitReason, s.escalated = 'exiting', self.clock, reason, nil
        native.exit(s.entry.npc, instant)
        note(s, 'exit', {reason = reason, instant = instant == true})
    end

    local function clipDuration(clip, rig) return clip.perRig and clip.perRig[rig] and clip.perRig[rig].duration or 3 end

    local function advance(s, context, mode, info)
        local npc = s.entry.npc
        if s.phase == 'spawning' or s.phase == 'recovering' and not s.playAt then
            if s.phase == 'spawning' and not (context.idle and context.settled) then finish(s, 'not settled before start'); return end
            local device, err = deviceFor(s, npc)
            if err then fail(s, 'device: ' .. err); return end
            if not device then
                if self.clock - s.since > 5 then fail(s, 'device spawn timed out') end
                return
            end
            s.device = device
            local ok, result = native.play(device, npc, s.component or s.family.component)
            if not ok then
                if not s.flavour and s.familyKey and s.known.fallback and s.familyKey ~= s.known.fallback then
                    self.missingFamilies[s.familyKey] = true
                    note(s, 'family-missing', {family = s.familyKey, error = tostring(result)})
                end
                fail(s, 'play: ' .. tostring(result)); return
            end
            s.playAt = self.clock
            if s.phase == 'spawning' then s.phase = 'starting' end
            note(s, 'play', {component = s.component})
            return
        end
        if s.phase == 'starting' or s.phase == 'recovering' then
            local inside = native.inWorkspot(npc)
            if inside then
                if s.phase == 'recovering' then
                    -- Re-entered only to leave cleanly: a native fast exit
                    -- after a short hold repairs a wedged command queue.
                    if self.clock - s.playAt >= policy.recoveryHold then
                        s.phase = 'active'; requestExit(s, 'recovery', false)
                    end
                    return
                end
                s.phase, s.activeAt = 'active', self.clock
                note(s, 'active', {})
            elseif self.clock - s.playAt > 3 then
                if not s.flavour and s.familyKey and s.known.fallback and s.familyKey ~= s.known.fallback then
                    self.missingFamilies[s.familyKey] = true
                    note(s, 'family-missing', {family = s.familyKey})
                    s.cooldownUntil = nil
                    s.phase, s.playAt = 'off', nil -- retry with the fallback family on the next settled tick
                    return
                end
                fail(s, 'never entered the workspot')
            end
            if s.phase ~= 'active' then return end
        end
        if s.phase == 'exiting' then
            local inside = native.inWorkspot(npc)
            if inside == false then s.playAt = nil; finish(s, s.exitReason); return end
            local waited = self.clock - s.exitAt
            if waited > policy.patience and not s.escalated then s.escalated = true; native.stopInDevice(npc); note(s, 'escalated', {}) end
            if waited > policy.giveUp then s.playAt = nil; fail(s, 'still in the workspot after exit') end
            return
        end
        if s.phase ~= 'active' then return end
        -- Leave on combat (instantly), on a native guard, on real movement, or
        -- after the reply ends plus a short linger.
        if context.combat then requestExit(s, 'combat', true); return end
        local allowed, reason = self.allowed(npc, self.player)
        if not allowed then requestExit(s, reason or 'guard', false); return end
        if context.settled then s.unsettledSince = nil else s.unsettledSince = s.unsettledSince or self.clock end
        local moved = distance(s.playerAnchor, self.playerPosition)
        if (tonumber(s.entry.playerGap) or 0) > policy.nearKeep then requestExit(s, 'too far', false); return end
        -- A single-tick speed spike (a collision nudge) is not running.
        if (self.playerSpeed or 0) > policy.playerRunning then s.runningSince = s.runningSince or self.clock else s.runningSince = nil end
        if moved > policy.playerMoved or (s.runningSince and self.clock - s.runningSince >= .3)
            or (s.unsettledSince and self.clock - s.unsettledSince > policy.unsettled) then
            requestExit(s, 'movement', false); return
        end
        if s.flavour then
            -- Signature idle: leave when its time is up or a conversation starts
            -- (the talk stance follows from the next settled tick).
            if mode ~= nil then requestExit(s, 'conversation', false)
            elseif self.clock >= s.flavourUntil then requestExit(s, 'flavour ended', false) end
            return
        end
        if mode == 'speaking' or mode == 'listening' then s.lingerUntil = self.clock + policy.linger
        elseif self.clock >= (s.lingerUntil or 0) and not s.clip then requestExit(s, 'reply ended', false); return end
        if s.clip and self.clock >= s.clip.ends - .2 then
            native.jump(npc, s.family.idle.name, false)
            s.clip = nil
        end
        if not s.clip and (mode == 'speaking' or mode == 'listening') then
            local pick = selection.next(s.sel, {now = self.clock, mode = mode, rig = s.rig, character = s.character,
                family = info and info.family, scale = info and info.scale, remaining = info and info.remaining,
                total = info and info.total, clips = s.family.clips})
            if pick then
                -- Instant jump (still blended by the workspot's inertialization):
                -- a queued jump waits for the 22-25 s idle loop to end (Oct 7 capture).
                local ok = native.jump(npc, pick.clip.name, true)
                if ok then
                    s.clip = {name = pick.clip.name, ends = self.clock + clipDuration(pick.clip, s.rig)}
                    note(s, 'gesture', {clip = pick.clip.name, category = pick.clip.category})
                end
            end
        elseif not s.clip and mode ~= 'speaking' and mode ~= 'listening' then
            selection.next(s.sel, {now = self.clock, mode = 'idle', rig = s.rig, clips = s.family.clips})
        end
    end

    -- After an exit, a wanted move must start. A command still only queued
    -- after wedgeAfter s means the AI did not resume: re-enter briefly and
    -- leave with a clean fast exit (verified live), at most twice a minute.
    local function health(s, context)
        if s.phase ~= 'off' or not s.healthFrom or self.clock - s.healthFrom > policy.healthWindow then return end
        local state = s.entry.motor and s.entry.motor.feedback and tostring(s.entry.motor.feedback.state or '') or ''
        if context.settled ~= false or not state:find('Enqueued', 1, true) then s.wedgedSince = nil; return end
        s.wedgedSince = s.wedgedSince or self.clock
        if self.clock - s.wedgedSince < policy.wedgeAfter then return end
        local recent = {}
        for _, at in ipairs(s.recoveries) do if self.clock - at < 60 then recent[#recent + 1] = at end end
        s.recoveries = recent
        if #recent >= policy.recoveryLimit then
            if not s.recoveryExhausted then s.recoveryExhausted = true; note(s, 'recovery-exhausted', {}) end
            return
        end
        local known, family, familyKey = characterOf(s.entry)
        if not known then return end
        s.recoveries[#s.recoveries + 1] = self.clock
        s.healthFrom = nil
        begin(s, known, family, true, false, familyKey)
    end

    function self.observe(entry, context, step)
        context = context or {}
        local s = stateFor(entry)
        s.observedTick = self.tickCount
        local ok, err = pcall(function()
            local mode, info = modeFor(s)
            if s.phase == 'off' then
                health(s, context)
                if s.phase ~= 'off' then return end
                if context.idle and context.settled and not context.combat
                    and (tonumber(entry.playerGap) or math.huge) <= policy.nearStart
                    and (not context.phase or policy.socialPhases[context.phase]) then s.settledSince = s.settledSince or self.clock
                else s.settledSince = nil end
                if not self.enabled() then return end
                local flavour = false
                if mode ~= 'speaking' and mode ~= 'listening' then
                    local known = characterOf(entry)
                    if mode ~= nil or not known or not known.flavour or not known.idle
                        or not self.catalog.idleComponents[known.idle] or not s.settledSince then return end
                    s.nextFlavourAt = s.nextFlavourAt or self.clock + between(policy.flavourFirst)
                    if self.clock - s.settledSince < policy.flavourSettled or self.clock < s.nextFlavourAt then return end
                    flavour = true
                end
                if self.clock < (s.cooldownUntil or 0) then return end
                if not (context.idle and context.settled) or context.combat then return end
                -- Only beside V, in a social stance: never for a copy left behind.
                if (tonumber(entry.playerGap) or math.huge) > policy.nearStart then return end
                if context.phase and not policy.socialPhases[context.phase] then return end
                local known, family, familyKey = characterOf(entry)
                if not known then return end
                if native.inWorkspot(entry.npc) ~= false then return end -- seats and scenes own their workspots
                local allowed = self.allowed(entry.npc, self.player)
                if not allowed then return end
                begin(s, known, family, false, flavour, familyKey)
                if flavour then s.nextFlavourAt = self.clock + between(policy.flavourGap) end
            end
            if not self.enabled() and s.phase == 'active' then requestExit(s, 'disabled', false) end
            advance(s, context, mode, info)
        end)
        if not ok then
            self.errors[#self.errors + 1] = tostring(err)
            if #self.errors > 8 then table.remove(self.errors, 1) end
            pcall(requestExit, s, 'error', true)
        end
        return HOLDING[s.phase] == true
    end

    function self.tick(player, step, rows)
        local dt = tonumber(step) or 0
        self.clock, self.tickCount, self.player = self.clock + dt, self.tickCount + 1, player
        local okPosition, at = pcall(function() return copy(player:GetWorldPosition()) end)
        if okPosition and at then
            self.playerSpeed = self.playerPosition and dt > 0 and distance(self.playerPosition, at) / dt or 0
            self.playerPosition = at
        end
        if not self.swept then self.swept = true; native.sweep() end
        local present = {}
        for _, row in ipairs(rows or {}) do present[row.entry.serial] = row end
        for serial, s in pairs(self.states) do
            local row = present[serial]
            if not row then
                if s.deviceID then native.deleteDevice(s.deviceID) end
                self.states[serial] = nil
            else
                s.entry = row.entry
                if HOLDING[s.phase] and (row.transport or (s.observedTick or 0) < self.tickCount - 1) then
                    -- Transport, recovery travel or a tactic took the copy.
                    pcall(requestExit, s, row.transport and 'transport' or 'unobserved', true)
                end
            end
        end
    end

    function self.release(entry, reason)
        local s = self.states[entry.serial]
        if not s then return end
        if HOLDING[s.phase] and entry.npc then native.exit(entry.npc, true) end
        if s.deviceID then native.deleteDevice(s.deviceID) end
        self.states[entry.serial] = nil
        self.log('released', {serial = entry.serial, reason = reason})
    end

    function self.abandon(reason)
        -- Native teardown: devices are non-persistent; no native calls here.
        self.states = {}
        self.swept = false
    end

    function self.snapshot()
        local rows = {}
        for serial, s in pairs(self.states) do
            rows[#rows + 1] = {serial = serial, phase = s.phase, family = s.known and s.known.talk, clip = s.clip and s.clip.name,
                last = s.last, recoveries = #s.recoveries, cooldown = s.cooldownUntil and math.max(0, s.cooldownUntil - self.clock) or 0}
        end
        return {enabled = self.enabled() == true, companions = rows, errors = self.errors}
    end

    return self
end

return M
