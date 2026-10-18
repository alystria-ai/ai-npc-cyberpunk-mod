-- Johnny in your head (docs/JOHNNY_IN_YOUR_HEAD.md): with the setting on, the talk keys that find nobody in front of V address
-- Johnny Silverhand, heard as the voice in V's head, while the story has him there.
--
-- Loaded by init.lua only while the setting is on, on the first talk key press that needs it (or the settings page drawing his
-- standing). It runs only when the player acts: on that key press, on a recording's validity poll and about twice a second while
-- his reply is heard (both held HOLD_SECONDS), and once per draw of the settings page. Never per frame, and it writes nothing:
-- the quest facts it reads are the save's own, so his standing is right for every save and follows a save load.
--
-- Three questions, each from plain values first (pure, tested), then from the game:
--   story   is Johnny in V's head now?   q101_done set (Playing for Time is over) and no ending fact set
--   stage   where do he and V stand?      a few shared milestones with verified writers in the 2.31 quest files
--   busy    does the game have the floor? a scene, a call, a quest conversation, a fight, V replaced, or a game line of his
local M = {KEY = 'johnny-silverhand', NAME = 'Johnny Silverhand', HOLD_SECONDS = 0.4, FACT_SECONDS = 5, LINE_SECONDS = 10}

-- Playing for Time is done: V woke with Johnny in her head (the name is the live game's, mod/knowledge-probe.lua).
M.START = 'q101_done'
-- An ending removed him (research/cyberpunk/native-rules/priority-endings-20261004.json, priority-phantom-20261004.json): the Devil,
-- the Star and the Sun epilogues, Temperance (Johnny keeps the body: nobody is in his head) and Phantom Liberty's Tower (the NUSA
-- surgery took him out; V wakes in 2079). After the credits the game returns to a save before the point of no return, where these
-- are absent again and he is back, as in the story.
M.ENDINGS = {'q201_active', 'q201_done', 'q202_active', 'q202_done', 'q203_active', 'q204_active', 'q204_done', 'q307_2079'}
-- What V and Johnny have been through together, each with its knowledge rule: the order is the order the bridge names them in.
M.MILESTONES = {
    {id = 'alt', fact = 'q110_made_contact_with_alt'},          -- ahe-native.alt-contact: they reached Alt beyond the Blackwall
    {id = 'bender', fact = 'sq031_cool_metal_fire_done'},       -- jr-priority.bender.completed: his night out in V's body
    {id = 'porsche', fact = 'sq031_porsche_unlocked'},          -- silverhand.porsche-recovered
    {id = 'second-chance', fact = 'sq032_johnny_friend'},       -- core-arcs.johnny.second-chance: the oil fields
    {id = 'rogue-date', fact = 'sq031_rogue_date_done'},        -- silverhand.movie-completed
    {id = 'reunion', fact = 'sq031_samurai_concert_done'},      -- silverhand.reunion-performed
}
-- The milestones that make friends close friends (two of them, after the second chance).
local CLOSE = {alt = true, porsche = true, ['rogue-date'] = true, reunion = true}

-- facts: {name = number} as read (an unreadable fact is absent). 'before', 'active', 'after' or 'unreadable'. Pure.
-- An unreadable start or ending closes the gate: Johnny stays quiet rather than talk before his time or after it.
function M.story(facts)
    if type(facts) ~= 'table' then return 'unreadable' end
    local start = facts[M.START]
    if type(start) ~= 'number' then return 'unreadable' end
    if start <= 0 then return 'before' end
    for _, name in ipairs(M.ENDINGS) do
        local value = facts[name]
        if type(value) ~= 'number' then return 'unreadable' end
        if value > 0 then return 'after' end
    end
    return 'active'
end

-- Where V and Johnny stand: the stage ('wary', 'grudging', 'friends', 'close') and the shared milestones in order, or the story
-- state ('before', 'after', 'unreadable') when he is not in V's head. An unreadable milestone counts as not reached. Pure.
--   wary      in V's head, nothing shared yet
--   grudging  at least one shared milestone, but no second chance at the oil fields (a refusal has no verified fact: it stays here)
--   friends   the second chance
--   close     the second chance and at least two of Alt, the Porsche, the Rogue date and the reunion
function M.stage(facts)
    local story = M.story(facts)
    if story ~= 'active' then return story, {} end
    local reached, close, second = {}, 0, false
    for _, row in ipairs(M.MILESTONES) do
        local value = facts[row.fact]
        if type(value) == 'number' and value > 0 then
            reached[#reached + 1] = row.id
            if row.id == 'second-chance' then second = true elseif CLOSE[row.id] then close = close + 1 end
        end
    end
    if second then return close >= 2 and 'close' or 'friends', reached end
    return #reached > 0 and 'grudging' or 'wary', reached
end

-- Did the game itself give Johnny a line in the last `window` seconds? rows: mod/game-dialogue.lua's buffer ({profileKey, at}, at in
-- os.time seconds, newest last; our own replies are never in it). Pure.
function M.recentLine(rows, now, key, window)
    if type(rows) ~= 'table' or type(now) ~= 'number' then return false end
    for index = #rows, math.max(1, #rows - 39), -1 do
        local row = rows[index]
        if type(row) == 'table' and type(row.at) == 'number' then
            if now - row.at > window then return false end
            if row.profileKey == key then return true end
        end
    end
    return false
end

-- Why the game has the floor now, from the player-side sample of mod/battle-observer.lua, or nil. Pure.
--   unreadable       no sample
--   replacer         V is replaced by another character (a flashback where the player is Johnny)
--   call             a phone call is incoming or running
--   dialogue         V is in a quest conversation
--   scene            scene tier 3 or above (limited gameplay or a cinematic), or a dialogue choice while the tier is unknown: the rule of
--                    mod/world-talk.lua for story characters. Tier 2 is staged gameplay (Viktor's clinic, Misty's shop) and does not
--                    refuse by itself; where the game stages its own Johnny there, his game line keeps Johnny quiet (johnny-speaking).
--                    A choice at tier 1 or 2 is the game's "Talk" prompt on a vendor or a fixer, not a conversation
--   combat           V is in a fight
--   johnny-speaking  the game gave Johnny a line in the last LINE_SECONDS (spoken: true)
function M.busy(sample, spoken)
    if type(sample) ~= 'table' or sample.available ~= true then return 'unreadable' end
    if sample.replacer == true then return 'replacer' end
    if sample.call == true then return 'call' end
    if sample.dialogue == true then return 'dialogue' end
    local tier = tonumber(sample.tier)
    if (tier ~= nil and tier >= 3) or (tier == nil and sample.choices == true) then return 'scene' end
    if sample.combat == true then return 'combat' end
    if spoken == true then return 'johnny-speaking' end
    return nil
end

-- What a head turn carries to the bridge (bridge/protocol.mjs parseHead): his stage and the milestones by id.
function M.headField(stage, reached)
    return {version = 1, stage = stage, milestones = reached or {}}
end

local function nativeFact(name) return Game.GetQuestsSystem():GetFactStr(name) end

-- options.readFact(name): a quest fact (GetFactStr). options.sample(player): the battle observer's sample. options.lines(): the
-- game-dialogue rows (or nil). options.now(): os.time seconds (the rows' clock). options.clock(): os.clock seconds (the holds).
function M.new(options)
    options = type(options) == 'table' and options or {}
    local readFact, clock, now = options.readFact or nativeFact, options.clock or os.clock, options.now or os.time
    local service = {key = M.KEY, name = M.NAME}
    local factsAt, held = nil, nil

    local function read(name)
        local ok, value = pcall(readFact, name)
        if ok and type(value) == 'number' and value == value and value >= 0 then return value end
        return nil
    end

    -- The facts the three questions need, held FACT_SECONDS. Before the story start nothing else is read.
    function service:facts()
        local at = clock()
        if self.cached and factsAt and at >= factsAt and at - factsAt < M.FACT_SECONDS then return self.cached end
        local facts = {[M.START] = read(M.START)}
        if type(facts[M.START]) == 'number' and facts[M.START] > 0 then
            for _, name in ipairs(M.ENDINGS) do facts[name] = read(name) end
            for _, row in ipairs(M.MILESTONES) do facts[row.fact] = read(row.fact) end
        end
        self.cached, factsAt = facts, at
        return facts
    end

    -- The stage for the settings page: one of M.stage's answers ('unreadable' reads as 'unknown').
    function service:standing()
        local stage = M.stage(self:facts())
        return stage == 'unreadable' and 'unknown' or stage
    end

    -- Why Johnny cannot answer now, or nil. 'before', 'after' and 'unreadable' mean he is not in V's head (the talk keys behave as
    -- with the setting off); the busy reasons mean he is there but the game has the floor. Held HOLD_SECONDS.
    function service:refusal(player)
        local at = clock()
        if held and at >= held.at and at - held.at < M.HOLD_SECONDS then return held.reason end
        local reason = M.story(self:facts())
        if reason == 'active' then
            local sample = nil
            if type(options.sample) == 'function' then
                local ok, value = pcall(options.sample, player)
                sample = ok and value or nil
            end
            local rows = nil
            if type(options.lines) == 'function' then
                local ok, value = pcall(options.lines)
                rows = ok and value or nil
            end
            reason = M.busy(sample, M.recentLine(rows, now(), M.KEY, M.LINE_SECONDS))
        end
        held = {at = at, reason = reason}
        return reason
    end

    -- The talk partner: V's own entity (no body of his; the holocall's audio route), his profile and the head field. nil when V's
    -- entity cannot be read.
    function service:partner(player)
        local ok, entity = pcall(function() return tostring(player:GetEntityID().hash) end)
        if not ok or type(entity) ~= 'string' or not entity:match('^%d+ULL$') then return nil end
        local stage, reached = M.stage(self:facts())
        return {npc = player, name = M.NAME, entity = entity, bodyType = '', profileKey = M.KEY, voiceOnly = true,
            head = M.headField(stage, reached)}
    end

    function service:reset() self.cached, factsAt, held = nil, nil, nil end
    return service
end

return M
