-- Two housemates talk to each other (docs/HOUSEMATES.md, "Pair chat").
--
-- One conversation at a time, between two people picked at random, of at most MAX_LINES lines in all (both speakers), then a pause of about
-- two minutes. Every line is one automatic spoken reaction that the game side makes (mod/init.lua, reaction kind 'house'); this module is only
-- the scheduler: it decides when a chat may start, who talks, how many lines, and when it must stop. Pure: the clock, the random numbers and
-- every game question come in through `env`.
--
-- Nothing runs unless the controller calls update() (only while V is in the flat with two or more housemates settled), so there is no cost
-- elsewhere, and no request, no connection and no line is made when V is not at home.
local M = {}

M.COOLDOWN = 120        -- seconds after a chat ends before the next may start (owner, 2026-10-25: about two minutes, on every provider)
M.MAX_LINES = 8         -- a hard stop, both speakers together
M.PLAN_LINES = 7        -- the usual length the speakers are told to aim for: 7 or 8 lines (MAX_LINES), the closing remark is the last one
M.GAP = {0.8, 1.6}      -- seconds between a finished line and the next request
M.LINE_TIMEOUT = 90     -- a line that has not been heard this long after its request ends the chat
M.FAIL_COOLDOWN = 60    -- extra pause after a chat that failed
M.NEAR_EACH_OTHER = 12  -- metres between the two speakers
M.NEAR_V = 25           -- metres from V: V can hear them
-- Chats per real hour at most, by the Companion speak-up level (the setting changes names on the next version: rare/rarely, medium/normally,
-- normal/often, about 2, 4 and 6 an hour). Off means no housemate chat.
M.LEVELS = {off = 0, rare = 2, medium = 4, normal = 6}
M.ALIAS = {rarely = 'rare', normally = 'medium', often = 'normal'}

-- Conversation openers: plain topics, never facts about V (the bridge turns one into a line in her own voice).
M.TOPICS = {
    'what to have for dinner', 'how the day went', 'something on the news feeds', 'a song one of them cannot get out of their head',
    'the neighbours', 'whether to go out later', 'an old story from before they met V', 'how tired they are',
    'something one of them saw on the street', 'a plan for tomorrow', 'a joke', 'the weather over Night City',
    'a memory of an old job', 'which of them is the messy one', 'something they would buy with a lot of eddies', 'a bad night they once had',
}

local function flat(a, b) return math.sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2 + ((a.z or 0) - (b.z or 0)) ^ 2) end

function M.new(env)
    local C = {}
    local clock = 0
    local state = {phase = 'idle', nextAt = 0, started = {}, recent = {}}
    local chat

    local function random() return env.random and env.random() or 0.5 end
    local function log(line) if env.log then pcall(env.log, line) end end

    local function levelName()
        local ok, value = pcall(env.level)
        value = ok and value or 'rare'
        value = M.ALIAS[value] or value
        if M.LEVELS[value] == nil then value = 'rare' end
        return value
    end

    local function hourlyCount()
        local count = 0
        for index = #state.started, 1, -1 do
            if clock - state.started[index] < 3600 then count = count + 1 else table.remove(state.started, index) end
        end
        return count
    end

    local function finish(reason, quiet)
        if not chat then return end
        local spoken = chat.spoken
        if chat.pendingLine and env.cancelSpeak then pcall(env.cancelSpeak) end
        if spoken > 0 and env.limiter and env.limiter.note then pcall(env.limiter.note, 'house', spoken) end
        if spoken > 0 then
            state.recent[#state.recent + 1] = {keys = chat.a.key .. '|' .. chat.b.key, at = clock}
            while #state.recent > 6 do table.remove(state.recent, 1) end
        end
        state.nextAt = clock + M.COOLDOWN + (reason == 'failed' and M.FAIL_COOLDOWN or 0)
        if not quiet then log('Housemate chat ended: ' .. reason .. ' lines=' .. tostring(spoken)) end
        if env.ended then pcall(env.ended, reason) end
        chat, state.phase = nil, 'idle'
    end

    local function still(person)
        local people = env.people()
        for _, candidate in ipairs(people) do if candidate.key == person.key then return candidate end end
        return nil
    end

    local function request()
        local index = chat.n + 1
        local speaker, partner = (index % 2 == 1) and chat.a or chat.b, (index % 2 == 1) and chat.b or chat.a
        local fresh = still(speaker)
        local other = still(partner)
        if not fresh or not other then return finish('dropped') end
        local lines = {}
        for i = math.max(1, #chat.lines - 5), #chat.lines do lines[#lines + 1] = chat.lines[i] end
        local ok, accepted = pcall(env.speak, {speaker = fresh, partner = other, n = index, of = chat.of, lines = lines,
            topic = index == 1 and chat.topic or nil})
        if not ok or not accepted then return finish('failed') end
        chat.n, chat.pendingLine, chat.requestedAt = index, true, clock
        state.phase = 'line'
    end

    -- A pair of two people near each other and V; the one pair that spoke last is least likely.
    local function pick(people)
        local candidates = {}
        for i = 1, #people do
            for j = i + 1, #people do
                local a, b = people[i], people[j]
                if flat(a, b) <= M.NEAR_EACH_OTHER then
                    local weight = 1
                    for _, recent in ipairs(state.recent) do
                        if recent.keys == a.key .. '|' .. b.key or recent.keys == b.key .. '|' .. a.key then weight = weight * 0.35 end
                    end
                    candidates[#candidates + 1] = {a = a, b = b, weight = weight}
                end
            end
        end
        local total = 0
        for _, candidate in ipairs(candidates) do total = total + candidate.weight end
        if total <= 0 then return nil end
        local r = random() * total
        for _, candidate in ipairs(candidates) do
            if r < candidate.weight then return candidate end
            r = r - candidate.weight
        end
        return candidates[#candidates]
    end

    -- Called by the controller at its step (about once a second while two or more housemates are settled). dt: seconds since the last call.
    function C.update(dt)
        clock = clock + (tonumber(dt) or 0)
        if state.phase == 'idle' then
            if clock < state.nextAt then return end
            local level = levelName()
            if M.LEVELS[level] == 0 then return end
            if hourlyCount() >= M.LEVELS[level] then return end
            local ok, may = pcall(env.mayStart)
            if not ok or may ~= true then return end
            if env.limiter and env.limiter.allow then
                local asked, allowed = pcall(env.limiter.allow, 'house', M.MAX_LINES)
                if not asked or allowed == false then return end
            end
            local people = env.people()
            if #people < 2 then return end
            local near = {}
            local vp = env.vPos and env.vPos() or nil
            for _, person in ipairs(people) do
                if not vp or flat(person, vp) <= M.NEAR_V then near[#near + 1] = person end
            end
            local pair = pick(near)
            if not pair then return end
            local topic = M.TOPICS[math.floor(random() * #M.TOPICS) + 1]
            state.started[#state.started + 1] = clock
            chat = {a = pair.a, b = pair.b, n = 0, of = random() < 0.5 and M.PLAN_LINES or M.MAX_LINES, lines = {}, spoken = 0, topic = topic,
                startedAt = clock}
            log('Housemate chat started: ' .. tostring(pair.a.key) .. ' and ' .. tostring(pair.b.key))
            return request()
        end
        if not chat then state.phase = 'idle'; return end
        if state.phase == 'between' then
            if chat.stopAfterLine then return finish(chat.stopReason or 'interrupted') end
            local ok, may = pcall(env.mayStart)
            if not ok or may ~= true then return finish('dropped') end
            if clock >= chat.gapUntil then return request() end
            return
        end
        -- phase 'line': the speaker's line is requested, being written or heard.
        local ok, status, text = pcall(env.status)
        if not ok then return finish('failed') end
        if status == 'done' then
            chat.pendingLine = false
            chat.spoken = chat.spoken + 1
            local speaker = ((chat.n % 2) == 1) and chat.a or chat.b
            chat.lines[#chat.lines + 1] = {speaker = speaker.name, text = tostring(text or ''):sub(1, 300)}
            if chat.n >= M.MAX_LINES or chat.n >= chat.of then return finish('done') end
            if chat.stopAfterLine then return finish(chat.stopReason or 'interrupted') end
            state.phase = 'between'
            chat.gapUntil = clock + M.GAP[1] + (M.GAP[2] - M.GAP[1]) * random()
        elseif status == 'failed' or status == 'cancelled' then
            chat.pendingLine = false
            return finish(status == 'cancelled' and 'interrupted' or 'failed')
        elseif clock - chat.requestedAt > M.LINE_TIMEOUT then
            return finish('failed')
        end
    end

    -- V talks to one of them, a scene starts, someone leaves. hard: stop now; otherwise the line in the air is finished first.
    function C.interrupt(reason, hard)
        if not chat then return end
        if hard or state.phase == 'between' then return finish(reason or 'interrupted') end
        chat.stopAfterLine, chat.stopReason = true, reason or 'interrupted'
    end
    function C.active() return chat ~= nil end
    -- Does this person take part in the chat now?
    function C.involves(key) return chat ~= nil and (chat.a.key == key or chat.b.key == key) end
    -- The text of a finished line is handed in by the speech pipeline before status() says 'done'; this only helps the tests.
    function C.snapshot()
        return {phase = state.phase, nextAt = state.nextAt, clock = clock, lines = chat and #chat.lines or 0, n = chat and chat.n or 0,
            hour = hourlyCount(), pair = chat and {chat.a.key, chat.b.key} or nil}
    end
    function C.reset() chat, state = nil, {phase = 'idle', nextAt = 0, started = {}, recent = {}} end
    return C
end

return M
