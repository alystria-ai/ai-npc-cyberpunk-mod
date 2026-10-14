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
M.policy = {firstClipMargin = .15, talkSettled = 1.0, reenterDelay = 4, flavourAfterTalk = 5, linger = 2.5, patience = 3, giveUp = 6, unsettled = .8, playerMoved = .75, playerRunning = 2.5,
    nearStart = 4.0, nearKeep = 4.5, socialPhases = {settled = true, attend = true}, faceWithin = 35, deviceSettle = 1.5, deviceRetry = .4,
    wedgeAfter = 1.5, healthWindow = 10, recoveryHold = .9, recoveryLimit = 2, failureCooldown = 30, minimumSpeech = 5,
    -- Idle flavour (characters marked flavour in the catalog, and the generic fallback): she goes into an idle as
    -- soon as she has been settled for a moment (a copy that never talked included), for 45-90 s, then again after a
    -- gap of 20-45 s measured from the end of the last one; five seconds after a reply ends (flavourAfterTalk).
    groupStagger = 2, exitSettle = .4, driftNote = .15, flavourSettled = 1.5, flavourFirst = {0, 0}, flavourGap = {20, 45}, flavourLength = {45, 90},
    -- An idle whose own animation walks the body away from V while V stands still. Live 2026-10-14 (Alex, V
    -- still): convai_idle_generic_hips slid her 0.7 m at +25 s and 2 m at +30 s (speed 1.2-2 m/s, gap 1.3 m to
    -- 3.7 m) and ended where it left her; the other idles never moved her. 'Gestures drift' logs for it on
    -- 2026-10-14 show the same component every time. Such idles are never picked (travellingIdles, by idle key),
    -- and any idle that carries the body more than driftExit metres is left at once and not picked again this
    -- session (the drifted idle is learned in self.travelling).
    driftExit = .45, travellingIdles = {generic_hips = true}}

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
        -- Group round membership: entity -> nil | 'recording' | 'reply', speaker entity | 'between' (group-chat.roleOf).
        group = options.group or function() return nil end,
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
    -- A record the catalog does not list (tier 2, named contacts, model-only copies) falls back to its body type:
    -- the rig's own talk family and hip or folded-arms idle (catalog.generic). Decided once per copy and cached;
    -- an unreadable body type is retried at most every 5 s, an unlisted one (fat, massive, mech, animal) never.
    self.generic = self.generic or {}
    local function genericOf(entry)
        local config = self.catalog.generic
        if not config or (config.never and config.never[entry.record]) then return nil end
        local cached = self.generic[entry.serial]
        if cached ~= nil then
            if cached then return cached end
            return nil
        end
        local retry = self.genericRetry and self.genericRetry[entry.serial]
        if retry and self.clock < retry then return nil end
        local body = entry.npc and native.bodyType and native.bodyType(entry.npc)
        if body == nil then
            self.genericRetry = self.genericRetry or {}
            self.genericRetry[entry.serial] = self.clock + 5
            return nil
        end
        local rig = config.bodyTypes and config.bodyTypes[body]
        local row = rig and config.rigs and config.rigs[rig]
        if not row then self.generic[entry.serial] = false; return nil end
        local known = {key = 'generic', rig = rig, talk = row.talk, idle = row.idle, idles = row.idles, flavour = true, fallback = row.talk, generic = true}
        self.generic[entry.serial] = known
        return known
    end
    -- The idles a copy may take: its own signature idle, its explicit pool, and (catalog.generic.mix) the clean generic
    -- idles of its rig. Cached per row; only idles the archive has a component for.
    self.pools = self.pools or {}
    self.travelling = self.travelling or {}
    local function poolOf(known)
        local cached = self.pools[known]
        if cached then return cached end
        local pool, seen = {}, {}
        local function add(key)
            if key and not seen[key] and self.catalog.idleComponents[key] then seen[key] = true; pool[#pool + 1] = key end
        end
        add(known.idle)
        for _, key in ipairs(known.idles or {}) do add(key) end
        local config = self.catalog.generic
        if config and config.mix and not known.generic then
            local row = config.rigs and config.rigs[known.rig]
            for _, key in ipairs(row and row.idles or {}) do add(key) end
        end
        self.pools[known] = pool
        return pool
    end
    -- The pool without the idles that walk the body (policy.travellingIdles, and those learned this session).
    local function flavourPool(known)
        local pool, kept = poolOf(known), {}
        for _, key in ipairs(pool) do
            if not policy.travellingIdles[key] and not self.travelling[key] then kept[#kept + 1] = key end
        end
        return kept
    end
    -- A random idle from the pool, never the one she just had when there is a choice.
    local function pickIdle(s, known)
        local pool = flavourPool(known)
        if #pool == 0 then return nil end
        local choices = {}
        for _, key in ipairs(pool) do if key ~= s.lastIdle or #pool == 1 then choices[#choices + 1] = key end end
        local key = choices[math.min(#choices, math.floor(((self.random or math.random)()) * #choices) + 1)]
        return key
    end
    local function characterOf(entry)
        local known = self.catalog.characters and self.catalog.characters[entry.record] or genericOf(entry)
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

    -- Latest phrase start (reply seconds) at or before the heard position, or
    -- nil when the timeline carries no phrase timing. Each timeline segment
    -- (local voices stream phrase by phrase) starts a phrase; within one, the
    -- expression track's spans do. A cursor keeps this O(1) per tick.
    local function phraseStart(s, speech)
        local spans, offset = speech.phrases, tonumber(speech.offset) or 0
        local known = speech.segmented == true or (type(spans) == 'table' and spans[1] ~= nil)
        if not known then s.phraseSpans, s.phraseAt = nil, nil; return nil end
        if s.phraseSpans ~= spans or s.phraseOffset ~= offset or s.phraseRequest ~= speech.requestId then
            s.phraseSpans, s.phraseOffset, s.phraseRequest, s.phraseCursor, s.phraseAt = spans, offset, speech.requestId, 1, offset
        end
        local at = speech.at or 0
        if type(spans) == 'table' then
            local cursor = s.phraseCursor
            while cursor <= 64 do
                local span = spans[cursor]
                local start = type(span) == 'table' and tonumber(span.start)
                if not start or offset + start > at then break end
                if offset + start > s.phraseAt then s.phraseAt = offset + start end
                cursor = cursor + 1
            end
            s.phraseCursor = cursor
        end
        return s.phraseAt
    end

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
                local phraseAt = phraseStart(s, speech)
                return 'speaking', {total = total, remaining = math.max(0, total - (speech.at or 0)),
                    family = speech.family, scale = speech.scale, requestId = speech.requestId,
                    phraseAt = phraseAt, phraseAge = phraseAt and math.max(0, (speech.at or 0) - phraseAt) or nil}
            end
            return 'short', nil
        end
        -- A member of a group round who is not speaking: she keeps the stance for the whole round (no
        -- leaving and re-entering between speakers) and nods now and then while V's group utterance is
        -- recorded or another companion's long reply is heard (selection.lua, group pacing).
        local role, speaker = self.group(entity)
        if role then
            if role == 'recording' then return 'listening', {group = true} end
            local heard = role == 'reply' and speaker ~= entity and self.speech(speaker)
            if heard then
                local total = math.max(heard.knownEnd or 0, self.replyEstimate(speaker, heard.requestId) or 0)
                if total >= policy.minimumSpeech then
                    local phraseAt = phraseStart(s, heard)
                    return 'listening', {group = true, total = total, remaining = math.max(0, total - (heard.at or 0)),
                        requestId = heard.requestId, phraseAt = phraseAt,
                        phraseAge = phraseAt and math.max(0, (heard.at or 0) - phraseAt) or nil}
                end
            end
            return 'thinking', nil
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

    -- The workspot plays at the device's transform, and a teleport of the device lands a frame
    -- or more after the call: a play right behind a move pulled the companion to the device's
    -- previous spot and yaw (Alex, Oct 10: turned toward V by her attention, then entered with
    -- the old yaw, and once 12 m back to where the stance had last been). The device is
    -- therefore moved, then checked against her actual pose, and played only once it matches;
    -- a device that does not follow is replaced by a new one spawned at her spot.
    local function deviceFor(s, npc)
        if s.deviceID then
            local entity = native.deviceEntity(s.deviceID)
            if entity == false then s.deviceID, s.device = nil, nil
            elseif entity then
                if not s.deviceMoved then
                    native.moveDevice(entity, npc)
                    s.deviceMoved, s.deviceMovedAt, s.deviceTriedAt = true, self.clock, self.clock
                end
                local placed = native.devicePlaced and native.devicePlaced(entity, npc)
                if native.devicePlaced == nil or placed == true then return entity end
                if placed == nil and self.clock - s.deviceMovedAt >= .3 then return entity end -- not measurable: give it a moment
                if self.clock - s.deviceMovedAt > policy.deviceSettle then
                    note(s, 'device-replaced', {})
                    native.deleteDevice(s.deviceID)
                    s.deviceID, s.device, s.deviceMoved = nil, nil, false
                elseif self.clock - s.deviceTriedAt >= policy.deviceRetry then
                    native.moveDevice(entity, npc); s.deviceTriedAt = self.clock
                    return nil
                else return nil end
            else return nil end
        end
        if not s.deviceID then
            local ok, id = native.spawnDevice(npc, self.catalog.device)
            if not ok then return nil, tostring(id) end
            -- Spawned exactly at her pose; the check above still runs before the play.
            s.deviceID, s.deviceMoved, s.deviceMovedAt, s.deviceTriedAt = id, true, self.clock, self.clock
        end
        return nil
    end

    local function between(range) return range[1] + (range[2] - range[1]) * ((self.random or math.random)()) end
    local function begin(s, known, family, recovery, flavour, familyKey)
        s.phase, s.since = recovery and 'recovering' or 'spawning', self.clock
        s.flavour = flavour == true
        s.idleKey = flavour and pickIdle(s, known) or nil
        s.lastIdle = s.idleKey or s.lastIdle
        s.component = flavour and s.idleKey and self.catalog.idleComponents[s.idleKey] or family.component
        s.flavourUntil = flavour and self.clock + between(policy.flavourLength) or nil
        s.known, s.family, s.rig, s.character, s.familyKey = known, family, known.rig, known.key, familyKey
        s.deviceMoved, s.clip, s.exitAt, s.playerAnchor, s.unsettledSince = false, nil, nil, copy(self.playerPosition), nil
        s.recovery, s.playAt = recovery == true, nil
        note(s, recovery and 'recovery-begin' or (flavour and 'flavour-begin') or 'begin', {family = known.talk, component = s.component})
    end
    local function finish(s, reason)
        note(s, 'finished', {reason = reason, exitLatency = s.exitAt and self.clock - s.exitAt})
        -- The workspot is left a tenth of a second after the exit signal, but the pose blends out for
        -- about half a second more (forced exit blend). Movement waits for that blend (observe keeps
        -- reporting the copy held), so she is never walked across the floor in the idle pose. A fast
        -- exit (combat, transport) and a start that never reached the workspot do not wait.
        s.settleUntil = s.exitAt and not s.exitInstant and self.clock + policy.exitSettle or nil
        s.phase, s.clip, s.exitAt, s.lingerUntil, s.recovery = 'off', nil, nil, nil, nil
        s.healthFrom, s.wedgedSince = self.clock, nil
        -- Every stance entry is a visible pose shuffle (the ambient legs differ from the
        -- stance by 15-30 cm). Do not re-enter at once after being pushed out by
        -- movement or a guard (the 21:48Z thrash: four enters in ten seconds), and keep the
        -- hand-on-hip idle away from the end of a reply (Oct 10 live).
        if reason ~= 'reply ended' and reason ~= 'conversation' and reason ~= 'flavour ended' and reason ~= 'disabled' then
            s.talkNotBefore = self.clock + policy.reenterDelay
        end
        if s.flavour then s.nextFlavourAt = self.clock + between(policy.flavourGap)
        else s.nextFlavourAt = math.max(s.nextFlavourAt or 0, self.clock + policy.flavourAfterTalk) end
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
        s.phase, s.exitAt, s.exitReason, s.escalated, s.exitInstant = 'exiting', self.clock, reason, nil, instant == true
        native.exit(s.entry.npc, instant)
        note(s, 'exit', {reason = reason, instant = instant == true})
    end

    -- The first clip waits until the enter blend into the stance is over: a
    -- gesture landing 0.1-0.4 s into the blend read as a body twitch (Oct 10).
    local function enterBlend(s) return (s.family and s.family.blend and tonumber(s.family.blend.enter)) or 1.1 end

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
                s.homeAt, s.driftNoted = copy(s.entry.position), nil
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
        -- Diagnostic: the workspot should hold her in place. Log once if the body moves anyway
        -- (2026-10-13, Evelyn: 0.24 m with V standing still). One table read per tick.
        if s.homeAt and not s.driftNoted and s.entry.position and distance(s.homeAt, s.entry.position) > policy.driftNote then
            s.driftNoted = true
            note(s, 'drift', {metres = distance(s.homeAt, s.entry.position),
                after = s.activeAt and self.clock - s.activeAt, component = s.component,
                from = copy(s.homeAt), to = copy(s.entry.position)})
        end
        -- An idle that carries the body away from where it began (V standing still) is left at once, so she does
        -- not keep walking to a new spot; the idle is not picked again this session.
        if s.flavour and s.homeAt and s.entry.position and distance(s.homeAt, s.entry.position) > policy.driftExit then
            if s.idleKey then self.travelling[s.idleKey] = true end
            note(s, 'drift-exit', {metres = distance(s.homeAt, s.entry.position), component = s.component,
                after = s.activeAt and self.clock - s.activeAt})
            requestExit(s, 'drifted', false); return
        end
        if s.flavour then
            -- Signature idle: leave when its time is up or a conversation starts
            -- (the talk stance follows from the next settled tick).
            if mode ~= nil then requestExit(s, 'conversation', false)
            elseif self.clock >= s.flavourUntil then requestExit(s, 'flavour ended', false) end
            return
        end
        if mode == 'speaking' or mode == 'listening' or mode == 'thinking' then s.lingerUntil = self.clock + policy.linger
        elseif self.clock >= (s.lingerUntil or 0) and not s.clip then requestExit(s, 'reply ended', false); return end
        if s.clip and self.clock >= s.clip.ends - .2 then
            native.jump(npc, s.family.idle.name, false)
            s.clip = nil
        end
        if not s.clip and (mode == 'speaking' or mode == 'listening') then
            local pick = selection.next(s.sel, {now = self.clock, mode = mode, rig = s.rig, character = s.character,
                family = info and info.family, scale = info and info.scale, remaining = info and info.remaining,
                total = info and info.total, reply = info and info.requestId, phraseAt = info and info.phraseAt,
                phraseAge = info and info.phraseAge, clips = s.family.clips, group = info and info.group,
                busyUntil = math.max((s.activeAt or 0) + enterBlend(s) + policy.firstClipMargin,
                    info and info.group and self.groupNodUntil or 0)})
            if pick then
                -- Two listeners of one round never start a nod together.
                if info and info.group then self.groupNodUntil = self.clock + policy.groupStagger end
                -- Instant jump (still blended by the workspot's inertialization):
                -- a queued jump waits for the 22-25 s idle loop to end (Oct 7 capture).
                local ok = native.jump(npc, pick.clip.name, true)
                if ok then
                    s.clip = {name = pick.clip.name, ends = self.clock + clipDuration(pick.clip, s.rig)}
                    note(s, 'gesture', {clip = pick.clip.name, category = pick.clip.category, group = info and info.group or nil})
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
            -- Setting Off and nothing held: no speech lookup at all (FPS).
            if s.phase == 'off' and not self.enabled()
                and not (s.healthFrom and self.clock - s.healthFrom <= policy.healthWindow) then s.settledSince = nil; return end
            -- A crouching V (or a copy held crouched): the workspot would pull her out of the pose, so
            -- none starts and a running one leaves at once (docs/COMPANION_GESTURES.md). One boolean.
            if context.crouched then
                if s.phase == 'off' then s.settledSince = nil; return end
                if s.phase ~= 'exiting' then requestExit(s, 'crouching', false) end
                advance(s, context, nil, nil)
                return
            end
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
                -- Thinking counts: the stance is entered while V waits for the reply, so the
                -- entry shuffle is over before the first word.
                local talking = mode == 'speaking' or mode == 'listening' or mode == 'thinking'
                if not talking then
                    local known = characterOf(entry)
                    if mode ~= nil or not known or not known.flavour or not s.settledSince
                        or #flavourPool(known) == 0 then return end
                    s.nextFlavourAt = s.nextFlavourAt or self.clock + between(policy.flavourFirst)
                    if self.clock - s.settledSince < policy.flavourSettled or self.clock < s.nextFlavourAt then return end
                    flavour = true
                end
                if self.clock < (s.cooldownUntil or 0) then return end
                if talking and (not s.settledSince or self.clock - s.settledSince < policy.talkSettled
                    or self.clock < (s.talkNotBefore or 0)) then return end
                -- The stance is placed at her pose and yaw: not while she is still turning toward V
                -- (her attention turn runs for a second or two after V looks at her).
                if (talking or flavour) and (tonumber(entry.facingError) or 0) > policy.faceWithin then return end
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
            end
            if not self.enabled() and s.phase == 'active' then requestExit(s, 'disabled', false) end
            advance(s, context, mode, info)
        end)
        if not ok then
            self.errors[#self.errors + 1] = tostring(err)
            if #self.errors > 8 then table.remove(self.errors, 1) end
            pcall(requestExit, s, 'error', true)
        end
        return HOLDING[s.phase] == true or (s.settleUntil ~= nil and self.clock < s.settleUntil)
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
        self.player = nil -- the tick stores V's handle; do not pin the old player across the unload
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
