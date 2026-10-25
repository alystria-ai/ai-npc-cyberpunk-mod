-- Companions and Johnny speak up on their own (feature 4): the scheduler and the arbiter. Pure and tested (bridge/speak-up.test.mjs);
-- it never touches the game, never reads a clock of its own (time arrives only through tick) and plain Lua 5.1 is enough for it.
--
-- Two speakers can start a line nobody asked for: a party COMPANION (our own copies) and JOHNNY (in V's head). Each has a level read from
-- the settings: 'off', 'rare', 'medium' or 'normal' (the stored values; normal is shown as Often, and Johnny's plain On, which means
-- answers only, reads as 'off' here). The numbers are TARGET RATES per hour of ELIGIBLE play, not caps (M.RATES): the scheduler's own
-- clock advances only while the caller says the moment is eligible (no combat, scene, call, menu, conversation, V typing ...), so time
-- that is not eligible is never counted and lines do not pile up afterwards.
--
-- Pacing. Each speaker has its own timer: when a level turns on (or changes) its next due time is drawn as clock + jitter(3600 / rate)
-- and a claim draws the next one from that moment. The jitter is uniform in [0.4, 1.6] x the mean (mean = 3600 / rate), so the long-run
-- average gap IS the mean, lines do not come like clockwork and none is ever closer than 0.4 x the mean to the previous one of the same
-- speaker (rare 1800 s mean, 720 s at the least; normal 600 s mean, 240 s at the least). Two speakers on means two timers, so the unified
-- rate is the sum of the two (rare + rare 4 an hour, normal + normal 12 ...), shared out by each speaker's own share. A minimum gap
-- (M.MIN_GAP, 150 s of eligible time, measured from the END of the last unprompted line) separates any two lines, and when both speakers
-- could speak, the one who spoke last yields (no back to back lines from one speaker because of the merge). The merge costs a little of
-- the rate where the gap is active: a speaker whose timer fell due inside the gap waits for it, and its next timer counts from the line.
--
-- Arbiter. One unprompted speaker at a time: pick says who may start, claim takes the floor, release gives it back. Johnny's FOLLOW-ON
-- (a short remark right after a companion's line, a reply V had in a conversation, or a scene) is the one exception to the gap: it is
-- one exchange. It still counts towards his rate (claim resets his timer) and it needs his timer to be due, so he never follows more
-- often than his rate allows; and it happens "sometimes, not every time" (M.FOLLOW_CHANCE).
--
-- Protocol with the caller (mod/init.lua):
--   every 0.1 s game tick:  sched:tick(dt, eligible)           (may be skipped while both levels are off)
--   to start a line:        local who = sched:pick({companion = hasLine, johnny = hasRemark})
--                           if who and sched:claim(who) then <start the line> end
--   when it is over:        sched:release(who, heard)           (heard == false: nobody heard it, refused, failed, cut before a word)
--   a follow-on:            release the source line first (release('companion', true)) or, for a conversation reply / scene that
--                           never held the floor, nothing; then  if sched:followOn(source) and sched:claim('johnny', {follow = true}) ...
local M = {}

M.RATES = {rare = 2, medium = 4, normal = 6}   -- target lines per hour of ELIGIBLE play, per speaker
M.MIN_GAP = 150                                 -- seconds of eligible time between the end of one unprompted line and the start of the next
M.FOLLOW_CHANCE = 0.5                           -- chance that Johnny follows a companion's line or a conversation reply when he may
M.MAX_STEP = 1                                  -- a tick longer than this is counted as this (a pause or a hitch is not play time)
M.RETRY = 15                                    -- a line nobody heard gives its timer back, but not due sooner than this many seconds from now
M.JITTER_SPAN = 1.2                             -- gap = mean x (1 + 1.2 (u - 0.5)), u uniform in [0, 1): mean preserved, bounded to [0.4, 1.6) x mean

local SPEAKERS = {companion = true, johnny = true}
local FOLLOW_SOURCES = {companion = true, talk = true, scene = true}

function M.new(options)
    options = type(options) == 'table' and options or {}
    local random = type(options.random) == 'function' and options.random or math.random
    local companionLevel, johnnyLevel = options.companionLevel, options.johnnyLevel
    local followChance = type(options.followChance) == 'number' and options.followChance or M.FOLLOW_CHANCE
    local sched = {}

    local clock = 0
    local holder, last, lastEnd = nil, nil, nil
    -- level: the level read at the last tick (nil = off); due: the clock time the speaker may next start; prev: the due time to give
    -- back if the line that took the floor is never heard.
    local state = {companion = {level = nil, due = nil, prev = nil}, johnny = {level = nil, due = nil, prev = nil}}
    local companion, johnny = state.companion, state.johnny

    local function unit()
        local ok, u = pcall(random)
        if not ok or type(u) ~= 'number' or u ~= u then return 0.5 end
        if u < 0 then return 0 end
        if u >= 1 then return 0.999999 end
        return u
    end

    -- The next due time for a speaker at this level, from the clock now.
    local function draw(level)
        local mean = 3600 / M.RATES[level]
        return clock + mean * (1 + M.JITTER_SPAN * (unit() - 0.5))
    end

    -- Read a level function: only 'rare', 'medium' and 'normal' are on; an error, nil, 'off' or 'on' is off. No allocation.
    local function readLevel(fn)
        if type(fn) ~= 'function' then return nil end
        local ok, value = pcall(fn)
        if ok and M.RATES[value] then return value end
        return nil
    end

    local function sync(s, level)
        if s.level == level then return end
        s.level = level
        s.prev = nil
        s.due = level and draw(level) or nil
    end

    function sched:tick(dt, eligible)
        local c, j = readLevel(companionLevel), readLevel(johnnyLevel)
        -- A level that changed is synced first, so a timer is drawn from the clock as it was when the level turned on.
        sync(companion, c)
        sync(johnny, j)
        if c == nil and j == nil then return end
        if eligible == true and type(dt) == 'number' and dt > 0 then
            clock = clock + (dt < M.MAX_STEP and dt or M.MAX_STEP)
        end
    end

    function sched:ready(speaker)
        local s = state[speaker]
        return s ~= nil and s.level ~= nil and s.due ~= nil and clock >= s.due
    end

    local function gapOk() return lastEnd == nil or clock - lastEnd >= M.MIN_GAP end

    -- Who may start an unprompted line now, or nil. candidates: {companion = bool, johnny = bool}, does that speaker HAVE something to say.
    -- Needs: the floor free, the gap since the last line ended, the speaker ready (level on, timer due) and a candidate. Both qualify:
    -- the one who did not speak last, and when neither did (or nobody has yet), a random one weighted by their rates. Does not claim.
    function sched:pick(candidates)
        if holder or type(candidates) ~= 'table' or not gapOk() then return nil end
        local c = candidates.companion == true and sched:ready('companion')
        local j = candidates.johnny == true and sched:ready('johnny')
        if c and j then
            if last == 'companion' then return 'johnny' end
            if last == 'johnny' then return 'companion' end
            local rc, rj = M.RATES[companion.level], M.RATES[johnny.level]
            return unit() * (rc + rj) < rc and 'companion' or 'johnny'
        end
        if c then return 'companion' end
        if j then return 'johnny' end
        return nil
    end

    -- Take the floor. false when someone holds it, the speaker is off, or (unless options.follow) it is not ready or the gap has not
    -- passed (the rates and the gap are hard bounds, not just advice to pick). options.follow = true (Johnny only): a follow-on, exempt
    -- from ready and the gap. Either way the speaker's timer is drawn again from now (the old one is kept for an unheard line).
    function sched:claim(speaker, claimOptions)
        local s = state[speaker]
        if not s or holder or not s.level then return false end
        local follow = type(claimOptions) == 'table' and claimOptions.follow == true
        if follow then
            if speaker ~= 'johnny' then return false end
        elseif not (s.due and clock >= s.due and gapOk()) then
            return false
        end
        s.prev = s.due
        s.due = draw(s.level)
        holder = speaker
        return true
    end

    -- Give the floor back. heard ~= false: the line was heard, it is now the last unprompted line and the gap counts from here.
    -- heard == false: nobody heard it, so the timer is given back (not due sooner than M.RETRY from now, so a failing line cannot be
    -- retried every tick) and the last speaker and end time stay as they were. false when the speaker did not hold the floor.
    function sched:release(speaker, heard)
        if not holder or holder ~= speaker then return false end
        local s = state[speaker]
        holder = nil
        if heard == false then
            if s.prev and s.level then
                local retry = clock + M.RETRY
                s.due = s.prev > retry and s.prev or retry
            end
        else
            last, lastEnd = speaker, clock
        end
        s.prev = nil
        return true
    end

    -- May Johnny follow a line that has just played (source: 'companion' a companion's unprompted line, 'talk' a reply V had in a
    -- conversation, 'scene')? True when his level is on, his timer is due, the floor is free (the caller releases the source line
    -- first: while the companion still holds the floor this is false, and claim would refuse too) and the dice say so
    -- (followChance, default M.FOLLOW_CHANCE: random() < chance). Never when Johnny himself holds the floor or the source is
    -- unknown. The caller then claims with {follow = true}.
    -- options.during = true: the decision is taken WHILE the companion's own line is still playing (so the follow-on can be written and
    -- voiced ahead, bridge/group-lookahead.mjs): the floor may then be held by that companion and by nobody else. The caller still releases her
    -- line when it is over and only then claims {follow = true}; if anything changed meanwhile the claim refuses.
    function sched:followOn(source, followOptions)
        if not FOLLOW_SOURCES[source] or not sched:ready('johnny') then return false end
        if holder then
            local during = type(followOptions) == 'table' and followOptions.during == true
            if not (during and source == 'companion' and holder == 'companion') then return false end
        end
        return unit() < followChance
    end

    -- Another feature's proactive exchange (the housemates' chat, convaiProactive in mod/init.lua): may one start now, and it has started.
    -- It shares the floor-free rule and the gap with the two speakers; noting one moves the end of the last line to the end of the exchange
    -- (about EXTERNAL_LINE_SECONDS a line) and draws the companion's timer again, so the merged pace counts it.
    M.EXTERNAL_LINE_SECONDS = 5
    function sched:externalAllowed() return holder == nil and gapOk() end
    function sched:external(kind, lines)
        local count = type(lines) == 'number' and lines == lines and lines > 0 and lines < 60 and lines or 1
        lastEnd = clock + count * M.EXTERNAL_LINE_SECONDS
        last = 'companion'
        if companion.level then companion.due = draw(companion.level) end
        return true
    end

    function sched:holder() return holder end
    function sched:busy() return holder ~= nil end
    function sched:lastSpeaker() return last end

    function sched:reset()
        holder, last, lastEnd = nil, nil, nil
        companion.level, companion.due, companion.prev = nil, nil, nil
        johnny.level, johnny.due, johnny.prev = nil, nil, nil
    end

    function sched:describe()
        local function side(name, s)
            return s.level and string.format('%s=%s due %.0f', name, s.level, s.due or -1) or (name .. '=off')
        end
        return string.format('speak-up clock %.0f %s %s holder %s last %s', clock, side('companion', companion),
            side('johnny', johnny), tostring(holder), tostring(last))
    end

    return sched
end

return M
