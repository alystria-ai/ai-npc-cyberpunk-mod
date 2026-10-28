-- Two housemates talk to each other (docs/HOUSEMATES.md, "Pair chat").
--
-- One conversation at a time, between two people picked at random (up to four with Settings > Housemates > Housemates in one chat), of at most
-- MAX_LINES lines in all (every speaker), then a pause of two minutes (Settings > Housemates > Pause between chats). Every line is one automatic spoken reaction that the game side makes (mod/init.lua, reaction kind 'house'); this module is only
-- the scheduler: it decides when a chat may start, who talks, how many lines, and when it must stop. Pure: the clock, the random numbers and
-- every game question come in through `env`.
--
-- The next line is written while the one before it is still being said: as soon as a line's text is known (env.status gives it while the line is in the
-- air) the request for the next speaker is prepared through env.prepare (the bridge runs it at once and holds it back), and when the line has been heard
-- that very request is sent with env.speak, flagged `prepared`, after a short beat (`gap`). Where nothing can be prepared (env.prepare absent or refused, or
-- a bridge that cannot run two lines at once) the next line is simply requested at the end of the one before, with no pause of our own.
--
-- Nothing runs unless the controller calls update() (only while V is in the flat with two or more housemates settled), so there is no cost
-- elsewhere, and no request, no connection and no line is made when V is not at home.
--
-- The same engine runs the short chat of the party companions that speak up together (docs/COMPANION_SPEAK_UP.md, "Group speak-up"; mod/init.lua
-- convaiParty*): there the owner starts it with start() (env.startOnly: update() never starts one itself), caps it with env.maxLines, names it with
-- env.label for the log and hears of its end, with the number of lines said, through env.ended(reason, spoken).
local M = {}

M.COOLDOWN = 120        -- seconds after a chat ends before the next may start unless env.cooldown says otherwise (owner, 2026-10-25: about two minutes)
M.MAX_PEOPLE = 4        -- the most people in one chat (env.groupSize, 2 to 4; the lines still come one at a time: one voice at a time)
M.MAX_LINES = 8         -- a hard stop, both speakers together
M.PLAN_LINES = 7        -- the usual length the speakers are told to aim for: 7 or 8 lines (MAX_LINES), the closing remark is the last one
M.GAP = {0.25, 0.5}     -- the beat in seconds between a heard line and the next one when that one is already written (the game side waits it out; a line that has to be written first needs none)
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
    -- The settings are read when a chat starts or ends, never per step. A missing or odd answer is the default.
    local function cooldown()
        local ok, value = pcall(env.cooldown or function() return M.COOLDOWN end)
        value = ok and tonumber(value) or M.COOLDOWN
        return (value >= 30 and value <= 3600) and value or M.COOLDOWN
    end
    local function groupSize()
        local ok, value = pcall(env.groupSize or function() return 2 end)
        value = ok and math.floor(tonumber(value) or 2) or 2
        return math.max(2, math.min(M.MAX_PEOPLE, value))
    end

    -- The most lines of this chat: the engine's own hard stop, or the lower cap its owner asks for (a party round is shorter than a housemates' chat).
    local function maxLines()
        local value = env.maxLines
        if type(value) ~= 'number' or value ~= value then return M.MAX_LINES end
        return math.max(2, math.min(M.MAX_LINES, math.floor(value)))
    end
    local function label() return type(env.label) == 'string' and env.label or 'Housemate chat' end

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
        if chat.prepared and env.unprepare then pcall(env.unprepare) end
        if spoken > 0 and env.limiter and env.limiter.note then pcall(env.limiter.note, 'house', spoken) end
        if spoken > 0 then
            state.recent[#state.recent + 1] = {keys = chat.people[1].key .. '|' .. chat.people[2].key, at = clock}
            while #state.recent > 6 do table.remove(state.recent, 1) end
        end
        state.nextAt = clock + cooldown() + (reason == 'failed' and M.FAIL_COOLDOWN or 0)
        if not quiet then log(label() .. ' ended: ' .. reason .. ' lines=' .. tostring(spoken)) end
        if env.ended then pcall(env.ended, reason, spoken) end
        chat, state.phase = nil, 'idle'
    end

    local function still(person)
        local people = env.people()
        for _, candidate in ipairs(people) do if candidate.key == person.key then return candidate end end
        return nil
    end

    -- The people take turns in order; line n is said by person ((n - 1) mod count) + 1 and answers the person before (the first line is
    -- aimed at the next one). Somebody who has gone from the flat is left out; with fewer than two left the chat is over. `now`: the line being said
    -- right now, not yet among chat.lines (a line prepared ahead is written with it in view). Returns the request and the people present, or nil.
    local function arrange(index, now)
        local present = {}
        for _, person in ipairs(chat.people) do
            local fresh = still(person)
            if fresh then present[#present + 1] = fresh end
        end
        if #present < 2 then return nil end
        local count = #present
        local at = (index - 1) % count + 1
        local speaker = present[at]
        local partner = present[index == 1 and at % count + 1 or (at - 2) % count + 1]
        local others = {}
        for _, person in ipairs(present) do
            if person.key ~= speaker.key and person.key ~= partner.key then others[#others + 1] = person.name end
        end
        local all, lines = chat.lines, {}
        local total = #all + (now and 1 or 0)
        for i = math.max(1, total - 5), total do lines[#lines + 1] = i <= #all and all[i] or now end
        return {speaker = speaker, partner = partner, others = others, n = index, of = chat.of, lines = lines,
            topic = index == 1 and chat.topic or nil}, present
    end
    -- What makes a prepared request the request that would be sent now.
    local function signature(args)
        local parts = {args.speaker.key, args.partner.key, table.concat(args.others, ','), tostring(args.n)}
        for _, line in ipairs(args.lines) do parts[#parts + 1] = line.speaker .. ':' .. line.text end
        return table.concat(parts, '|')
    end

    local function request()
        local args, present = arrange(chat.n + 1)
        if not args then return finish('dropped') end
        chat.people = present
        -- Prepared ahead and still the same request: the game side sends the very table it prepared.
        local prepared = chat.prepared
        chat.prepared = nil
        if prepared then
            if prepared.signature == signature(args) then
                args.prepared, args.gap = true, M.GAP[1] + (M.GAP[2] - M.GAP[1]) * random()
            elseif env.unprepare then pcall(env.unprepare) end
        end
        local ok, accepted = pcall(env.speak, args)
        if not ok or not accepted then return finish('failed') end
        chat.n, chat.pendingLine, chat.requestedAt, chat.speaker = args.n, true, clock, args.speaker
        state.phase = 'line'
    end

    -- The text of the line in the air is known: write the next speaker's line now (once per line).
    local function prepare(text)
        local index = chat.n + 1
        chat.preparedFor = chat.n
        local args = arrange(index, {speaker = chat.speaker.name, text = text:sub(1, 300)})
        if not args then return end
        local ok, accepted = pcall(env.prepare, args)
        if ok and accepted then chat.prepared = {signature = signature(args), n = index} end
    end

    -- Up to `size` people near each other and V: a pair first (the pair that spoke last is least likely), then the nearest of the others.
    local function pick(people, size)
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
        local chosen = candidates[#candidates]
        for _, candidate in ipairs(candidates) do
            if r < candidate.weight then chosen = candidate; break end
            r = r - candidate.weight
        end
        local group = {chosen.a, chosen.b}
        if size > 2 then
            local rest = {}
            for _, person in ipairs(people) do
                if person.key ~= chosen.a.key and person.key ~= chosen.b.key and flat(person, chosen.a) <= M.NEAR_EACH_OTHER then rest[#rest + 1] = person end
            end
            table.sort(rest, function(x, y) return flat(x, chosen.a) < flat(y, chosen.a) end)
            for i = 1, math.min(#rest, size - 2) do group[#group + 1] = rest[i] end
        end
        return group
    end

    -- Called by the controller at its step (about once a second while two or more housemates are settled). dt: seconds since the last call.
    function C.update(dt)
        clock = clock + (tonumber(dt) or 0)
        if state.phase == 'idle' then
            if env.startOnly == true then return end
            if clock < state.nextAt then return end
            local level = levelName()
            if M.LEVELS[level] == 0 then return end
            if hourlyCount() >= M.LEVELS[level] then return end
            local ok, may = pcall(env.mayStart)
            if not ok or may ~= true then return end
            if env.limiter and env.limiter.allow then
                local asked, allowed = pcall(env.limiter.allow, 'house', maxLines())
                -- A limiter that fails (a different version of the arbiter) is ignored: the pause and the level still apply.
                if asked and allowed == false then return end
            end
            local people = env.people()
            if #people < 2 then return end
            local near = {}
            local vp = env.vPos and env.vPos() or nil
            for _, person in ipairs(people) do
                if not vp or flat(person, vp) <= M.NEAR_V then near[#near + 1] = person end
            end
            local group = pick(near, groupSize())
            if not group then return end
            local topic = M.TOPICS[math.floor(random() * #M.TOPICS) + 1]
            state.started[#state.started + 1] = clock
            chat = {people = group, n = 0, of = random() < 0.5 and M.PLAN_LINES or M.MAX_LINES, lines = {}, spoken = 0, topic = topic,
                startedAt = clock}
            local keys = {}
            for _, person in ipairs(group) do keys[#keys + 1] = tostring(person.key) end
            log('Housemate chat started: ' .. table.concat(keys, ' and '))
            return request()
        end
        if not chat then state.phase = 'idle'; return end
        -- phase 'line': the speaker's line is requested, being written or heard.
        local ok, status, text = pcall(env.status)
        if not ok then return finish('failed') end
        if status == 'done' then
            chat.pendingLine = false
            chat.spoken = chat.spoken + 1
            chat.lines[#chat.lines + 1] = {speaker = chat.speaker.name, text = tostring(text or ''):sub(1, 300)}
            if chat.n >= maxLines() or chat.n >= chat.of then return finish('done') end
            if chat.stopAfterLine then return finish(chat.stopReason or 'interrupted') end
            local may
            ok, may = pcall(env.mayStart)
            if not ok or may ~= true then return finish('dropped') end
            -- The next line is requested at once, not at some later step: the pause between lines is the writing of it, or a beat when it is written.
            return request()
        elseif status == 'failed' or status == 'cancelled' then
            chat.pendingLine = false
            return finish(status == 'cancelled' and 'interrupted' or 'failed')
        elseif clock - chat.requestedAt > M.LINE_TIMEOUT then
            return finish('failed')
        elseif env.prepare and status == 'busy' and chat.preparedFor ~= chat.n and not chat.stopAfterLine and chat.n < chat.of and chat.n < maxLines()
            and type(text) == 'string' and text ~= '' then
            prepare(text)
        end
    end

    -- Start a chat of the given people (two to MAX_PEOPLE, the first speaks first) now, by its owner: a party round. options.of: the lines it is planned for
    -- (2 to maxLines; the closing remark is the last one). false when one is in progress or the people are too few; the first line is requested at once.
    function C.start(group, options)
        if chat or state.phase ~= 'idle' or type(group) ~= 'table' or #group < 2 or #group > M.MAX_PEOPLE then return false end
        local planned = type(options) == 'table' and tonumber(options.of) or nil
        planned = planned and math.max(2, math.min(maxLines(), math.floor(planned))) or math.min(maxLines(), M.PLAN_LINES)
        state.started[#state.started + 1] = clock
        chat = {people = group, n = 0, of = planned, lines = {}, spoken = 0, topic = type(options) == 'table' and options.topic or nil, startedAt = clock}
        local keys = {}
        for _, person in ipairs(group) do keys[#keys + 1] = tostring(person.key) end
        log(label() .. ' started: ' .. table.concat(keys, ' and '))
        request()
        return chat ~= nil
    end

    -- V talks to one of them, a scene starts, someone leaves. hard: stop now; otherwise the line in the air is finished first.
    function C.interrupt(reason, hard)
        if not chat then return end
        -- A line that has not begun (it waits for its beat or for the channel) is not in the air: there is nothing to finish.
        if not hard and chat.pendingLine then
            local asked, status = pcall(env.status)
            if asked and status == 'waiting' then hard = true end
        end
        if hard or not chat.pendingLine then return finish(reason or 'interrupted') end
        chat.stopAfterLine, chat.stopReason = true, reason or 'interrupted'
    end
    -- The game side says a line has just ended (mod/init.lua convaiHouseTick): read it now instead of at the controller's next step, so the next line
    -- is requested without waiting for the step.
    function C.poke() if chat and state.phase == 'line' then C.update(0) end end
    -- Development: start the next chat at once (the cooldown and the hourly count cleared).
    function C.force() state.nextAt, state.started = 0, {}; return true end
    function C.active() return chat ~= nil end
    -- Does this person take part in the chat now?
    function C.involves(key)
        if not chat then return false end
        for _, person in ipairs(chat.people) do if person.key == key then return true end end
        return false
    end
    -- The text of a finished line is handed in by the speech pipeline before status() says 'done'; this only helps the tests.
    function C.snapshot()
        return {phase = state.phase, nextAt = state.nextAt, clock = clock, lines = chat and #chat.lines or 0, n = chat and chat.n or 0,
            hour = hourlyCount(), pair = chat and {chat.people[1].key, chat.people[2].key} or nil, people = chat and #chat.people or 0}
    end
    function C.reset() chat, state = nil, {phase = 'idle', nextAt = 0, started = {}, recent = {}} end
    return C
end

return M
