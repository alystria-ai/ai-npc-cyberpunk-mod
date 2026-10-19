-- V talks on their own (docs/V_TALKS.md): with Settings > Conversations > V talks on their own at Rare or Normal, V now and then starts a short
-- exchange with a companion in the party, and the companion answers. It happens mostly after something intense (a fight that counted, a main
-- or side job finished) and now and then on a calm walk or ride.
--
-- This module is the policy, the queue and V's lines only (pure, tested): which events are kept, when an exchange may start, how often, who
-- speaks and what V says. The events come from collectors that already run (mod/battle-reactions.lua's encounter state, mod/journal-history.lua's
-- history scan, the 0.5 s observer sample); init.lua hands them over and offers a due exchange on the existing 0.1 s game tick through the
-- automatic-reaction path (the same reply owner, lease and cancellation as battle and loot reactions and Johnny's remarks). Nothing here runs
-- per frame, and nothing is loaded while the select is Off.
--
-- V's lines are written here, not by a model: a reviewed bank per trigger, so V never invents a decision, an outcome, a name or a fact the
-- knowledge rules do not support (bridge/v-talks.mjs words what the companion is told). The companion's answer is a real turn. Lifepath only
-- colours the calm lines, and says only what the lifepath itself fixes.
local M = {}

-- Rare: at least 15 minutes between exchanges and at most 2 an hour. Normal: at least 5 minutes and at most 6 an hour.
M.LEVELS = {rare = {gap = 900, hour = 2}, normal = {gap = 300, hour = 6}}
-- Calm time (no fight, no scene, no call) before a walk or ride may bring a chat, plus a random share of up to CALM_JITTER more, and how
-- far V must have travelled in that time (a V standing still is not "on a walk").
M.CALM_SECONDS = {rare = 1200, normal = 600}
M.CALM_JITTER = 0.5
M.CALM_MOVED = 40
M.TTL = {fight = 90, job = 240}              -- how long an event waits for its moment (scenes, calls and talk come first)
M.QUIET_SECONDS = {fight = 8, job = 15}      -- never sooner than this after the event (the fight's last shot, the job's last line)
M.FIGHT_MIN_SECONDS = 20                     -- a fight shorter than this is a scuffle, not "something intense"
M.LINE_SECONDS = 10                          -- never within 10 s of a game line (a scene or an ambient line is still going on)
M.AFTER_REACTION = 15                        -- never within 15 s of the end of another automatic reaction
M.SEND_SECONDS = 60                          -- an exchange step that was sent must be heard within this (the reaction's deadline)
M.FOLLOW_PAUSE = 2                           -- the pause between a companion's answer and V's next line
M.FOLLOW_SECONDS = 25                        -- the second part must start within this after the first one ended, or the exchange is over
M.LONG_CHANCE = 0.4                          -- the share of exchanges that run to four lines (V, companion, V, companion)
M.MAX_QUEUE = 4
M.SPEAKER_RANGE = 12                         -- the companion must be this near V (metres)
M.SILENT_SECONDS = 600                       -- after the bridge said V's voice cannot speak, no new exchange for this long
M.SUBJECT_SECONDS = 3600                     -- the same fight or job is not talked about again for an hour
M.REPEAT_SECONDS = 1800                      -- the same trigger does not start two exchanges in a row within this
M.USED = 8                                   -- V does not say one of his last eight lines again
M.TITLE_MAX = 60

-- V's lines. {title} is a finished job's title, in quotes; a line with it is used only when the title is short and plain. No line states an
-- outcome (a fight is never "won", a job's end is never good or bad), a name, a choice V made, V's health, Johnny or the Relic: tests/v-talks
-- scans this bank for them. The lifepath keys are what bridge/turn-context.mjs sends: nomad, streetkid, corpo.
M.LINES = {
    fight = {
        'Everyone still breathing?',
        'That got loud fast.',
        'You hurt? Be honest.',
        'Okay. Give me a second to breathe.',
        'Eyes open. Quiet like this never lasts.',
        'Anyone need a minute?',
        'Remind me to duck more next time.',
        'That was closer than I like.',
        'Still on your feet? Good.',
        "Let's not make a habit of that.",
    },
    jobDone = {
        "That job's behind us.",
        'One more off the list.',
        "Okay. That one's done.",
        "That's that, then.",
        "What's next, you think?",
        'Let that sink in for a second.',
    },
    jobDoneTitled = {
        '"{title}" is done.',
        'So that\'s "{title}" behind us.',
    },
    jobFailed = {
        "Well. That one's over, one way or another.",
        "Okay. That's done, for better or worse.",
        'Not every job ends clean.',
        'We move on. What now?',
    },
    jobFailedTitled = {
        '"{title}" is done, for better or worse.',
        'That\'s "{title}" closed out, one way or another.',
    },
    walk = {
        "Quiet for once. I'll take it.",
        'Nobody shooting at us. Nice change.',
        'Night City never really sleeps, does it?',
        'Anything on your mind?',
        'Where would you go, if you could go anywhere?',
        'Keeping an eye out. Old habit.',
        "Rare slow moment. Let's enjoy it.",
        'You ever get tired of this city?',
        'Thanks for sticking around.',
        'Tell me something that has nothing to do with work.',
    },
    walkTone = {
        nomad = {'Streets are fine, but I still miss open sky.', 'Give me a long road over a skyline any day.'},
        streetkid = {"Grew up on streets like these. Still don't trust them.", 'Every corner here has a story. Most end badly.'},
        corpo = {'Funny. I used to spend days like this behind glass.', 'Quiet moments like this never happened in an office.'},
    },
    ride = {
        'Nice to go somewhere without a gun in my hand.',
        'Smooth ride, for once.',
        "Traffic's behaving. Don't jinx it.",
        'Anything you want to talk about while we drive?',
        "Open road's good for thinking.",
        'Quiet ride. I could get used to it.',
    },
    rideTone = {
        nomad = {'Nothing beats wheels under you. Takes me back.'},
        streetkid = {'Any ride beats walking these streets.'},
        corpo = {'This beats the commute I used to have.'},
    },
    -- The second part's opener: it answers whatever the companion said, so it commits to nothing.
    follow = {
        'Mm. Noted.',
        'Heh. Fair enough.',
        'Yeah. I hear you.',
        "Right. Let's keep moving.",
        'Good to know.',
        'Okay. Thanks for that.',
        "Huh. I'll think about it.",
        'Fair. Moving on.',
    },
}

local function clean(value, limit)
    if type(value) ~= 'string' then return nil end
    local text = value:gsub('<[^>]*>', ''):gsub('%c', ' '):gsub('%s+', ' '):match('^%s*(.-)%s*$')
    if text == '' or #text > limit or text:match('^LocKey#') then return nil end
    return text
end

-- A fight the encounter state (mod/battle-reactions.lua capture) says is over and long enough to count -> subject, facts, witnesses (a set
-- of profile keys that were near V when it started), or nil. Pure.
function M.fightEvent(capture)
    if type(capture) ~= 'table' or capture.status ~= 'ended' or type(capture.encounter) ~= 'string'
        or not capture.encounter:match('^battle%-%d+$') then return nil end
    if (tonumber(capture.durationSeconds) or 0) < M.FIGHT_MIN_SECONDS then return nil end
    -- One that ended long ago is not news (the setting may have just been switched on): it would be dropped as expired anyway.
    if (tonumber(capture.ageSeconds) or 0) > M.TTL.fight then return nil end
    local witnesses = {}
    if type(capture.witnesses) == 'table' then
        for _, key in ipairs(capture.witnesses) do if type(key) == 'string' then witnesses[key] = true end end
    end
    return 'fight:' .. capture.encounter, {encounter = capture.encounter}, witnesses
end

-- The journal types a talk is worth: main and side jobs (no gigs or NCPD scanner hustles).
local QUEST_TYPES = {MainQuest = true, SideQuest = true, MinorQuest = true}

-- A job the history scan newly found finished (mod/journal-history.lua onFinished) -> subject and facts, or nil. Pure.
function M.jobEvent(quest)
    if type(quest) ~= 'table' or (quest.state ~= 'succeeded' and quest.state ~= 'failed') then return nil end
    if quest.questType ~= nil and not QUEST_TYPES[quest.questType] then return nil end
    local title = clean(quest.title, 160)
    if not title then return nil end
    return 'job:' .. tostring(quest.id or title), {title = title, outcome = quest.state}
end

-- Why the game has the floor now, from the player-side sample of mod/battle-observer.lua, or nil. The same rule as Johnny in V's head, except
-- that a vehicle is fine here (a ride is a place to talk): no sample, V replaced by someone else, a phone call, a quest conversation, scene
-- tier 3 or above (or a dialogue choice while the tier is unknown), a fight in progress. Tier 2 is staged gameplay and stays open.
function M.busy(sample)
    if type(sample) ~= 'table' or sample.available ~= true then return 'unreadable' end
    if sample.replacer == true then return 'replacer' end
    if sample.call == true then return 'call' end
    if sample.dialogue == true then return 'dialogue' end
    local tier = tonumber(sample.tier)
    if (tier ~= nil and tier >= 3) or (tier == nil and sample.choices == true) then return 'scene' end
    if sample.combat == true then return 'combat' end
    return nil
end

-- Did the game show any line in the last `window` seconds? rows: mod/game-dialogue.lua's buffer ({at}, os.time seconds, newest last). Pure.
function M.recentLine(rows, now, window)
    if type(rows) ~= 'table' or type(now) ~= 'number' then return false end
    local row = rows[#rows]
    return type(row) == 'table' and type(row.at) == 'number' and now - row.at <= window
end

-- V's lifepath as the turn context sends it, or nil.
function M.tone(snapshot)
    local value = type(snapshot) == 'table' and snapshot.lifepath or nil
    if value == 'nomad' or value == 'streetkid' or value == 'corpo' then return value end
    return nil
end

-- The companion who answers. people: the reaction rows (mod/init.lua reactionPeople, nearest first). Only a party companion in reach who can
-- speak: never a character another mod spawned. options.keep {entity, profileKey}: the exchange's own companion (or nil when gone);
-- otherwise options.prefer (a set of profile keys: who saw the fight) first, then anyone near, and not the one who spoke last when another can.
function M.pickSpeaker(people, options)
    options = type(options) == 'table' and options or {}
    local best
    for _, person in ipairs(type(people) == 'table' and people or {}) do
        if type(person) == 'table' and not person.spawned and person.available ~= false and type(person.entity) == 'string'
            and type(person.profileKey) == 'string' and (tonumber(person.distance) or math.huge) <= M.SPEAKER_RANGE then
            if options.keep then
                if person.entity == options.keep.entity and person.profileKey == options.keep.profileKey then return person end
            else
                local score = (options.prefer and options.prefer[person.profileKey] and 2 or 0) + (person.profileKey ~= options.last and 1 or 0)
                if not best or score > best.score then best = {person = person, score = score} end
            end
        end
    end
    return best and best.person or nil
end

local function squareDistance(a, b)
    if type(a) ~= 'table' or type(b) ~= 'table' then return nil end
    local x, y, z = (tonumber(a.x) or 0) - (tonumber(b.x) or 0), (tonumber(a.y) or 0) - (tonumber(b.y) or 0), (tonumber(a.z) or 0) - (tonumber(b.z) or 0)
    return x * x + y * y + z * z
end

-- Has V travelled far enough since `from` to be "on a walk or a ride"? where: V's position now. Pure.
function M.moved(from, where)
    local square = squareDistance(from, where)
    return square ~= nil and square >= M.CALM_MOVED * M.CALM_MOVED
end

-- options.level(): 'off', 'rare' or 'normal'. options.random(): a number in [0, 1). Times are os.time seconds, passed in.
function M.new(options)
    options = type(options) == 'table' and options or {}
    local random = type(options.random) == 'function' and options.random or math.random
    local service = {queue = {}, said = {}, subjects = {}, used = {}, serial = 0}

    local function levelName() local ok, value = pcall(options.level); return ok and M.LEVELS[value] and value or nil end

    -- Keep an event (kind: 'fight' or 'job'). False when the select is Off, the subject was talked about in the last hour, or it is malformed.
    function service:note(kind, subject, facts, now, prefer)
        if not levelName() or not M.TTL[kind] or type(subject) ~= 'string' or type(facts) ~= 'table' or type(now) ~= 'number' then return false end
        local last = self.subjects[subject]
        if last and now - last < M.SUBJECT_SECONDS then return false end
        for _, entry in ipairs(self.queue) do if entry.subject == subject then return false end end
        if #self.queue >= M.MAX_QUEUE then table.remove(self.queue, 1) end
        self.queue[#self.queue + 1] = {kind = kind, subject = subject, facts = facts, prefer = prefer, at = now}
        return true
    end

    -- A fresh observer sample: is V in calm open gameplay? `position()` reads V's place (called only when a calm spell begins). A spell
    -- that breaks (a fight, a scene, a call) starts over, so a walk or ride talk always comes after a stretch of quiet.
    function service:watch(calm, now, position)
        local name = levelName()
        if not name then return end
        if not calm then self.calmSince, self.calmDue, self.calmFrom = nil, nil, nil; return end
        if self.calmSince then return end
        self.calmSince = now
        self.calmDue = now + M.CALM_SECONDS[name] * (1 + M.CALM_JITTER * random())
        local ok, where = pcall(position)
        self.calmFrom = ok and type(where) == 'table' and where or nil
    end

    -- Anything that could be offered soon (a few comparisons: the 0.1 s tick asks this before anything else).
    function service:active(now)
        if self.exchange then return self.exchange.state == 'between' end
        if #self.queue > 0 or (self.calmDue ~= nil and now >= self.calmDue) then return self:allowed(now) end
        return false
    end

    -- The rate limit: the gap since the last exchange began, and the count in the last hour.
    function service:allowed(now)
        local name = levelName()
        local cfg = name and M.LEVELS[name]
        if not cfg then return false end
        if self.mutedUntil and now < self.mutedUntil then return false end
        local recent = 0
        for index = #self.said, 1, -1 do
            if now - self.said[index] < 3600 then recent = recent + 1 else table.remove(self.said, index) end
        end
        local last = self.said[#self.said]
        return recent < cfg.hour and (not last or now - last >= cfg.gap)
    end

    -- The same trigger twice in a row is refused (within REPEAT_SECONDS of the last one).
    local function repeated(self, kind, now)
        return self.lastKind == kind and self.lastAt ~= nil and now - self.lastAt < M.REPEAT_SECONDS
    end

    -- The exchange to start now, or nil: expired events are dropped first; then the oldest event past its quiet time whose trigger is not the
    -- last one; then a calm walk or ride when V has been quiet long enough and has really been travelling. ctx.ride: V is in a vehicle;
    -- ctx.where(): V's position now (read only when a calm talk is about to be offered).
    function service:offer(now, ctx)
        if self.exchange then return nil end
        for index = #self.queue, 1, -1 do
            if now - self.queue[index].at > M.TTL[self.queue[index].kind] then table.remove(self.queue, index) end
        end
        if not self:allowed(now) then return nil end
        for _, entry in ipairs(self.queue) do
            if now - entry.at >= M.QUIET_SECONDS[entry.kind] and not repeated(self, entry.kind, now) then return entry end
        end
        if self.calmDue and now >= self.calmDue then
            ctx = type(ctx) == 'table' and ctx or {}
            local kind = ctx.ride == true and 'ride' or 'walk'
            if repeated(self, kind, now) then return nil end
            local ok, where = pcall(ctx.where or function() return nil end)
            if not (ok and M.moved(self.calmFrom, where)) then
                -- Standing still: not a walk. The spell starts over from here.
                self.calmSince, self.calmDue, self.calmFrom = nil, nil, nil
                return nil
            end
            return {kind = kind, subject = kind, facts = {ride = kind == 'ride'}, at = now}
        end
        return nil
    end

    -- The lines V may say for this exchange's first part.
    local function pool(exchange, tone)
        local lines, kind, facts = M.LINES, exchange.kind, exchange.facts
        local titled = type(facts.title) == 'string' and #facts.title >= 2 and #facts.title <= M.TITLE_MAX and not facts.title:find('["{}]')
        local out = {}
        local function add(list, withTitle)
            for _, line in ipairs(list or {}) do
                out[#out + 1] = withTitle and line:gsub('{title}', function() return facts.title end) or line
            end
        end
        if kind == 'fight' then add(lines.fight)
        elseif kind == 'job' then
            local done = facts.outcome ~= 'failed'
            add(done and lines.jobDone or lines.jobFailed)
            if titled then add(done and lines.jobDoneTitled or lines.jobFailedTitled, true) end
        elseif kind == 'ride' then add(lines.ride); add(tone and lines.rideTone[tone])
        else add(lines.walk); add(tone and lines.walkTone[tone]) end
        return out
    end

    -- Open an exchange for an offered entry: its length is decided now (two parts or four lines are the only lengths).
    function service:open(entry, now)
        self.serial = self.serial + 1
        return {id = 'vt-' .. tostring(now) .. '-' .. self.serial, kind = entry.kind, subject = entry.subject, facts = entry.facts,
            prefer = entry.prefer, entry = entry, step = 1, steps = random() < M.LONG_CHANCE and 2 or 1, state = 'new'}
    end

    -- What V says in this exchange's current step. A line V said in the last few is left out unless nothing else is left.
    function service:line(exchange, tone)
        local candidates = pool(exchange, tone)
        if exchange.step ~= 1 then
            candidates = {}
            for _, line in ipairs(M.LINES.follow) do candidates[#candidates + 1] = line end
        end
        local fresh = {}
        for _, line in ipairs(candidates) do
            local seen = false
            for _, old in ipairs(self.used) do if old == line then seen = true; break end end
            if not seen then fresh[#fresh + 1] = line end
        end
        if #fresh > 0 then candidates = fresh end
        local line = candidates[math.min(#candidates, 1 + math.floor(random() * #candidates))]
        self.used[#self.used + 1] = line
        if #self.used > M.USED then table.remove(self.used, 1) end
        return line
    end

    -- A step was sent (init.lua wrote the request). The first step takes the entry out of the queue and counts towards the rate; the
    -- speaker stays the exchange's own for the next step.
    function service:started(exchange, now, speaker, requestId)
        exchange.state, exchange.speaker, exchange.requestId = 'speaking', speaker or exchange.speaker, requestId
        if exchange.step ~= 1 then return end
        if exchange.entry then
            for index, other in ipairs(self.queue) do
                if other == exchange.entry then table.remove(self.queue, index); break end
            end
        end
        exchange.previousKind, exchange.previousAt, exchange.claimedAt = self.lastKind, self.lastAt, now
        self.subjects[exchange.subject] = now
        self.said[#self.said + 1] = now
        self.lastKind, self.lastAt = exchange.kind, now
        self.calmSince, self.calmDue, self.calmFrom = nil, nil, nil
        self.exchange = exchange
    end

    -- A step could not be sent: it is dropped (its event too, so a failing write is not retried every tick).
    function service:abandon(exchange)
        if exchange.entry then
            for index, other in ipairs(self.queue) do
                if other == exchange.entry then table.remove(self.queue, index); break end
            end
        end
        if self.exchange == exchange then self.exchange = nil end
    end

    -- A step ended (init.lua cancelAutomatic). heard: the companion's reply started playing; completed: it played to its end. A first part
    -- nobody heard gives its rate slot back (and does not count as the last trigger); a part that was heard and completed lets the
    -- exchange go on to its second part, if it has one.
    function service:stepEnded(id, heard, completed, now)
        local exchange = self.exchange
        if not exchange or exchange.id ~= id then return end
        if exchange.step == 1 and not heard then
            for index = #self.said, 1, -1 do
                if self.said[index] == exchange.claimedAt then table.remove(self.said, index); break end
            end
            self.lastKind, self.lastAt = exchange.previousKind, exchange.previousAt
            self.exchange = nil
            return
        end
        if heard and completed and exchange.step < exchange.steps then
            exchange.state, exchange.since = 'between', now
            return
        end
        self.exchange = nil
    end

    -- The exchange whose next step is due now (the pause has passed), moved on to that step, or nil. One that waited too long is over.
    function service:continuing(now)
        local exchange = self.exchange
        if not exchange or exchange.state ~= 'between' then return nil end
        if now - exchange.since > M.FOLLOW_SECONDS then self.exchange = nil; return nil end
        if now - exchange.since < M.FOLLOW_PAUSE then return nil end
        exchange.step, exchange.state = exchange.step + 1, 'new'
        return exchange
    end

    -- The exchange is over whatever its state (the companion left, V's voice went off, a scene started).
    function service:finish() self.exchange = nil end

    -- The bridge said V's voice cannot speak these lines (no clip, no voice ready, another language): quiet for a while.
    function service:silenced(now) self.mutedUntil = now + M.SILENT_SECONDS end

    -- A world change (save load) forgets the queue, the calm spell and the exchange; what was said and the subjects stay (real time).
    function service:reset()
        self.queue, self.exchange, self.fightSeen, self.sampleAt = {}, nil, nil, nil
        self.calmSince, self.calmDue, self.calmFrom = nil, nil, nil
    end
    return service
end

return M
