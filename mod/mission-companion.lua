-- A game-placed story character V is talking to during a mission, kept company like one of V's own (docs/WORLD_CHARACTERS.md,
-- "Talk during missions"). Experimental, off by default (Settings > Conversations > Talk during missions); with it Off this file is
-- never loaded and nothing here exists.
--
-- What it adds on top of the talk path, for a character V has talked to while a quest is tracked: combat remarks, loot and speak-up (the
-- reaction rows), the idle face (blinks, resting and listening faces), following V on foot and sitting in V's car.
--
-- THE GAME HAS PRIORITY. Every poll (twice a second, from the battle observer's own poll, never per frame) the arbiter asks whether the
-- mission script is driving the character: a cutscene or quest conversation V is in, the character in a scene dialogue, a workspot of a
-- scene, a scripted move (a command that is not ours), a scripted vehicle ride, an injury, or a fact that could not be read. If so every
-- system here steps back at once (our own commands are cancelled, the rows are withdrawn) and resumes only after the script has let go for
-- RESUME_CLEAR seconds. Nothing here ever fights a script.
--
-- WHAT IT NEVER DOES: teleport, despawn, hide, change the AI role, change attitude, equipment, stance, appearance, the quest facts, the
-- character's story state or the journal. Movement is one plain AIFollowTargetCommand with teleport off, a seat is one AIMountCommand, and
-- both are cancelled the moment the script drives or the character is released.
--
-- RELEASE. A character is released when the setting is turned off, when the tracked mission ends or changes, when V leaves it far behind,
-- when it is gone or dead, and on any world change. A release cancels our commands, stands the character out of V's car if we seated it
-- (only while the game is not driving it), and withdraws the face and reaction rows.
local M = {POLL = 0.45, RESUME_CLEAR = 1.5, MAX_MEMBERS = 3, FAR = 120, FAR_GRACE = 10,
    QUEST_EVERY = 2, QUEST_MISSES = 3, ESCORT_FAR = 10, ESCORT_NEAR = 5, FOLLOW_RETRY = 3,
    RIDE_REACH = 25, RIDE_RETRY = 5, RIDE_TRIES = 3}

-- The reasons the game is driving the character, and how much steps back:
--   scene  everything (the game has the character's whole presence): an unreadable fact, a cutscene or quest conversation V is in, the
--          character in a scene dialogue, a workspot while V is in staged gameplay, an injury
--   body   the body (follow, seat, rows): a scripted move or ride, a workspot in open gameplay
-- facts: the world-talk.read facts. own: {commanding = true} while a command of ours is active (the AI then reads as commanded; that is us).
-- Returns nil, or reason and level. Pure.
function M.driving(facts, own)
    if type(facts) ~= 'table' then return 'unreadable', 'scene' end
    if facts.hub == true then return 'cutscene', 'scene' end
    if facts.dialogue == true then return 'dialogue', 'scene' end
    if facts.hurt == true then return 'hurt', 'scene' end
    if facts.workspot == true and facts.staged ~= false then return 'workspot', 'scene' end
    for _, name in ipairs({'hub', 'dialogue', 'hurt', 'driven', 'mounted', 'workspot'}) do
        if type(facts[name]) ~= 'boolean' then return 'unreadable', 'scene' end
    end
    local commanding = type(own) == 'table' and own.commanding == true
    if facts.workspot == true then return 'workspot', 'body' end
    if facts.driven == true and not commanding then
        return facts.mounted == true and 'scripted-vehicle' or 'scripted', 'body'
    end
    return nil
end

local function terminal(state)
    return state == 'Success' or state == 'Failure' or state == 'Cancelled' or state == 'Interrupted' or state == 'Detached'
end
M.terminal = terminal

-- options (all injected, so the core runs without the game):
--   setting() -> bool                       Talk during missions (and Talk to story characters) are on
--   now() -> seconds                        a monotonic clock
--   alive(npc) -> bool                      attached and not dead
--   distance(npc, player) -> metres | nil
--   read(npc, player, sample) -> facts      mod/world-talk.lua facts, with the workspot read
--   quest() -> id | nil                     the tracked quest
--   follow(npc, player) -> op | nil         send one follow command (teleport off)
--   playerVehicle(player) -> vehicle | nil  the car V sits in
--   freeSeat(vehicle, npc) -> seat | nil    an empty seat, and canBoard(npc) -> bool, reason
--   mount(npc, vehicle, seat, out) -> op    one mount (out = true: leave the car) command
--   mounted(npc) -> bool
--   state(op) -> 'Executing' | ... | nil, cancel(op) -> bool (finished)
--   changed(set), released(member, reason)  the face and reaction rows changed / a member was released (the glue withdraws the face)
--   log(line)
function M.new(options)
    options = type(options) == 'table' and options or {}
    local now, log = options.now or os.clock, options.log or function() end
    local service = {members = {}, lastAt = nil, count = 0}

    -- The members the game is not driving (free) and the ones it is (held): the face layer writes only for the first and is kept off the second.
    local function sets()
        local free, held = {}, {}
        for _, m in ipairs(service.members) do if m.level then held[m.entity] = true else free[m.entity] = true end end
        return free, held
    end
    local function publish() if options.changed then pcall(options.changed, sets()) end end

    local function opState(m, which)
        local op = m[which]
        if not op then return nil end
        local ok, state = pcall(options.state, op)
        return ok and state or nil
    end
    local function commanding(m)
        for _, which in ipairs({'follow', 'mount'}) do
            local state = opState(m, which)
            if m[which] and (state == nil or not terminal(state)) then return true end
        end
        return false
    end
    -- Our command is over (finished, interrupted by the script or cancelled by us): forget it.
    local function sweepOps(m)
        for _, which in ipairs({'follow', 'mount'}) do
            if m[which] then
                local state = opState(m, which)
                if state ~= nil and terminal(state) then
                    if state == 'Interrupted' and not m.cancelled then m.interruptedAt = now() end
                    m[which], m.cancelled = nil, nil
                end
            end
        end
    end
    local function cancelOps(m)
        for _, which in ipairs({'follow', 'mount'}) do
            if m[which] then
                m.cancelled = true
                local ok, done = pcall(options.cancel, m[which])
                if ok and done == true then m[which], m.cancelled = nil, nil end
            end
        end
    end

    local function find(entity) for index, m in ipairs(service.members) do if m.entity == entity then return m, index end end end
    function service:member(entity) return (find(entity)) end

    -- A character V talked to, while a quest is tracked: it joins in. Refused with the setting off, with no mission, or when full.
    function service:attach(npc, key, name, entity, bodyType)
        if not (options.setting and options.setting()) or not npc or type(entity) ~= 'string' or type(key) ~= 'string' then return false end
        if find(entity) then return true end
        if #self.members >= M.MAX_MEMBERS then return false end
        local quest = options.quest and options.quest() or nil
        if quest == nil then return false end
        self.members[#self.members + 1] = {npc = npc, entity = entity, key = key, name = name or key, quest = quest, bodyType = bodyType,
            attachedAt = now(), level = nil, questMiss = 0, rideTries = 0}
        -- The row the gesture controller sees (mod/companion-gestures.lua): stable per member, its own "allowed" check, no scene flag.
        local m = self.members[#self.members]
        m.entry = {serial = 'mission:' .. entity, entityID = {hash = entity}, npc = npc, profileKey = key, name = m.name, state = 'ready',
            mission = true, speed = 0, facingError = 0, allowed = options.gestureAllowed,
            record = options.record and select(2, pcall(options.record, npc)) or nil}
        log('Mission companion joined: ' .. tostring(name) .. ' (' .. key .. ') quest=' .. tostring(quest))
        publish()
        return true
    end

    -- A member leaves. `quiet`: the world is gone, so no native call is made (the handle is stale).
    function service:release(entity, reason, quiet)
        local m, index = find(entity)
        if not m then return false end
        table.remove(self.members, index)
        if not quiet then
            cancelOps(m)
            -- Seated by us and the game is not driving it: it gets out the ordinary way (never instantly, never by teleport).
            if m.rideVehicle and m.level == nil and options.mounted then
                local mountedOk, mounted = pcall(options.mounted, m.npc)
                if mountedOk and mounted == true then pcall(options.mount, m.npc, m.rideVehicle, m.rideSeat, true) end
            end
        end
        if options.released then pcall(options.released, m, reason, quiet) end
        log('Mission companion released: ' .. tostring(m.name) .. ' reason=' .. tostring(reason))
        publish()
        return true
    end

    function service:releaseAll(reason, quiet)
        for index = #self.members, 1, -1 do self:release(self.members[index].entity, reason, quiet) end
    end

    local function stepBack(m, reason, level)
        local was = m.level
        m.level, m.reason, m.clearAt, m.freed = level, reason, nil, nil
        if was == nil then
            cancelOps(m)
            log('Mission companion steps back: ' .. m.name .. ' reason=' .. reason .. ' level=' .. level)
            if options.stepped then pcall(options.stepped, m) end
            publish()
        end
    end

    local function resume(m)
        m.level, m.reason, m.clearAt = nil, nil, nil
        m.rideTries = 0
        log('Mission companion resumes: ' .. m.name)
        publish()
    end

    -- The systems, only while the game is not driving: follow V on foot, sit in V's car. One command at a time, never a teleport.
    local function systems(m, player, facts, gap, t)
        local vehicle = options.playerVehicle and options.playerVehicle(player) or nil
        local seated = options.mounted and options.mounted(m.npc) == true
        if vehicle and not seated and not m.mount and gap and gap <= M.RIDE_REACH
            and m.rideTries < M.RIDE_TRIES and (not m.rideAt or t >= m.rideAt) then
            local board = options.canBoard == nil or select(1, options.canBoard(m.npc)) == true
            local seat = board and options.freeSeat and options.freeSeat(vehicle, m.npc) or nil
            m.rideAt = t + M.RIDE_RETRY
            if seat then
                if m.follow then cancelOps(m) end
                m.rideTries = m.rideTries + 1
                m.mount = options.mount(m.npc, vehicle, seat, false)
                if m.mount then m.rideVehicle, m.rideSeat = vehicle, seat; log('Mission companion boards: ' .. m.name .. ' seat=' .. tostring(seat)) end
                return
            end
        end
        if not vehicle and m.rideVehicle and seated and not m.mount then
            m.mount = options.mount(m.npc, m.rideVehicle, m.rideSeat, true)
            log('Mission companion gets out: ' .. m.name)
            return
        end
        if m.rideVehicle and not seated and not m.mount and not vehicle then m.rideVehicle, m.rideSeat = nil, nil end
        if seated or m.mount or facts.mounted == true then return end
        if gap and not m.follow and gap > M.ESCORT_FAR and (not m.followAt or t >= m.followAt) then
            m.followAt = t + M.FOLLOW_RETRY
            m.follow = options.follow(m.npc, player)
            if m.follow then log('Mission companion follows: ' .. m.name) end
        elseif m.follow and gap and gap <= M.ESCORT_NEAR then
            cancelOps(m)
        end
    end

    local function poll(m, player, sample, t)
        if not (options.alive and options.alive(m.npc)) then service:release(m.entity, 'gone', true); return end
        local gap = options.distance and options.distance(m.npc, player) or nil
        m.entry.playerGap = gap
        -- Her own speed since the last poll: the gesture controller starts a stance only for a character standing still.
        local at = options.position and options.position(m.npc) or nil
        if at and m.lastAt and t > m.lastAt and m.lastPosition then
            m.entry.speed = math.sqrt((at.x - m.lastPosition.x) ^ 2 + (at.y - m.lastPosition.y) ^ 2) / (t - m.lastAt)
        end
        m.lastPosition, m.lastAt = at, t
        if gap and gap > M.FAR then
            m.farSince = m.farSince or t
            if t - m.farSince >= M.FAR_GRACE then service:release(m.entity, 'left-behind'); return end
        else m.farSince = nil end
        -- The mission ended or changed: the tracked quest is no longer the one V talked to this character in.
        if not m.questAt or t - m.questAt >= M.QUEST_EVERY then
            m.questAt = t
            local quest = options.quest and options.quest() or nil
            m.questMiss = quest == m.quest and 0 or m.questMiss + 1
            if m.questMiss >= M.QUEST_MISSES then service:release(m.entity, 'mission-ended'); return end
        end
        sweepOps(m)
        local facts = options.read(m.npc, player, sample)
        local reason, level = M.driving(facts, {commanding = commanding(m)})
        -- A command of ours that the script interrupted a moment ago is the script driving, even when the AI reads as autonomous again.
        if not reason and m.interruptedAt and t - m.interruptedAt < M.RESUME_CLEAR then reason, level = 'scripted', 'body' end
        if reason then
            stepBack(m, reason, level)
            return
        end
        if m.level then
            m.clearAt = m.clearAt or t
            if t - m.clearAt >= M.RESUME_CLEAR then resume(m) end
            return
        end
        -- Free: the face may speak under our own commanded AI (the glue tells Face.reds once; stepped() takes it back).
        if not m.freed then m.freed = true; if options.freed then pcall(options.freed, m) end end
        systems(m, player, facts, gap, t)
    end

    -- The one member now (the key press that joined it): the arbiter's verdict is known before the first reply starts.
    function service:check(entity, player, sample)
        local m = find(entity)
        if not m then return false end
        local ok, err = pcall(poll, m, player, sample, now())
        if not ok then log('Mission companion error: ' .. tostring(err)); self:release(entity, 'error') end
        return ok
    end

    -- Once per poll of the battle observer. Returns at once between polls and when there is nobody; with the setting turned off everyone
    -- is released.
    function service:update(player, sample)
        if #self.members == 0 then return end
        local t = now()
        if not (options.setting and options.setting()) then self:releaseAll('setting-off'); return end
        if self.lastAt and t >= self.lastAt and t - self.lastAt < M.POLL then return end
        self.lastAt = t
        local list = {}
        for index, m in ipairs(self.members) do list[index] = m end
        for _, m in ipairs(list) do
            if find(m.entity) then
                local ok, err = pcall(poll, m, player, sample, t)
                if not ok then
                    log('Mission companion error: ' .. tostring(err))
                    self:release(m.entity, 'error')
                end
            end
        end
    end

    -- The members that may act now (the game is not driving them): the rows of the reaction people and of the idle face.
    function service:rows(player)
        local rows = {}
        for _, m in ipairs(self.members) do
            if not m.level then
                local gap = options.distance and options.distance(m.npc, player) or nil
                rows[#rows + 1] = {npc = m.npc, entity = m.entity, profileKey = m.key, name = m.name, bodyType = m.bodyType, distance = gap or 0,
                    story = true, mission = true}
            end
        end
        return rows
    end

    -- Body gestures (docs/COMPANION_GESTURES.md) through the party's gesture controller, only for a member the game is not driving. Per frame,
    -- but only while somebody has joined in: observe each free member (a standing, settled one may enter a talk or idle stance) and hand back
    -- the rows with theirs added, so the controller does not drop their state. A member that steps back or is released has its stance left at
    -- once by the `stepped` and `released` hooks. `rows` is not changed.
    function service:gestures(controller, step, combat, rows)
        local out = {}
        for index, row in ipairs(rows or {}) do out[index] = row end
        local playerSpeed = tonumber(controller.playerSpeed) or 0
        for _, m in ipairs(self.members) do
            if not m.level then
                local still = (tonumber(m.entry.speed) or 0) < 0.18 and not m.follow and not m.mount
                local ok = pcall(controller.observe, m.entry, {idle = still, settled = still and playerSpeed < 0.28, phase = 'settled',
                    combat = combat == true, crouched = false, suspendHold = function() end, resumeHold = function() end}, step)
                if ok then out[#out + 1] = {entry = m.entry, transport = false} end
            end
        end
        return out
    end

    -- The members whose face the idle writer may drive (the game is not driving them): no native call, a table read.
    function service:faces()
        local rows = {}
        for _, m in ipairs(self.members) do
            if not m.level then rows[#rows + 1] = {npc = m.npc, entity = m.entity, profileKey = m.key, name = m.name, bodyType = m.bodyType, mission = true} end
        end
        return rows
    end

    function service:status()
        local list = {}
        for _, m in ipairs(self.members) do list[#list + 1] = {entity = m.entity, key = m.key, level = m.level, reason = m.reason,
            following = m.follow ~= nil, boarding = m.mount ~= nil, seated = m.rideVehicle ~= nil} end
        return list
    end

    return service
end

return M
