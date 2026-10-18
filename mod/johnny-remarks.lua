-- Johnny speaks up (docs/JOHNNY_IN_YOUR_HEAD.md, phase 2): with Johnny in your head on and Settings > Johnny speaks up at Rare or
-- Normal, Johnny makes a short unprompted remark when V has just met a named character, finished a job, or a romance moved on.
--
-- This module is the policy and the queue only (pure, tested): which events are kept, when one may be spoken, and how often. The events
-- come from collectors that already run (mod/game-dialogue.lua's subtitle feed, mod/journal-history.lua's history scan,
-- mod/relationship-state.lua's romance facts); init.lua hands them over and offers a due remark on the existing 0.1 s game tick through
-- the automatic-reaction path (the same reply owner, lease and cancellation as battle and loot reactions). Nothing here runs per frame,
-- and nothing is loaded while the select is Off.
--
-- Places (step 2): init.lua reads the district V is in every PLACE_SECONDS on the existing 0.5 s battle sample (only while both settings
-- are on) and hands the record names to placeTracker; an arrival at a place on M.PLACES becomes a 'place' event with its own cooldown.
local M = {}

-- Rare: at least 15 minutes between remarks and at most 2 an hour. Normal: at least 5 minutes and at most 6 an hour.
M.LEVELS = {rare = {gap = 900, hour = 2}, normal = {gap = 300, hour = 6}}
M.SUBJECT_SECONDS = 3600   -- the same person, job or romance is not remarked on again for an hour (a place has its own cooldown)
M.QUIET_SECONDS = 10       -- never within 10 s of the last game line the event saw (a scene is still going on)
M.SEND_SECONDS = 60        -- a remark that was sent must be heard within this (the reaction's deadline)
M.MAX_QUEUE = 6
-- How long an event waits for its moment (scenes, calls and talk come first): a person until a while after the last line they spoke.
M.TTL = {person = 180, quest = 240, romance = 300, place = 90}
-- The romance facts mod/relationship-state.lua reads, as Johnny would hear them (who, and what moved on).
M.ROMANCES = {
    sq030_judy_lover = {who = 'judy-alvarez', name = 'Judy', what = 'together'},
    sq030_friendship = {who = 'judy-alvarez', name = 'Judy', what = 'friends'},
    sq027_panam_lover = {who = 'panam-palmer', name = 'Panam', what = 'together'},
    sq029_river_lover = {who = 'river-ward', name = 'River', what = 'together'},
    sq028_kerry_relationship = {who = 'kerry-eurodyne', name = 'Kerry', what = 'together'},
    sq028_kerry_dislike = {who = 'kerry-eurodyne', name = 'Kerry', what = 'declined'},
    q003_stout_sex_done = {who = 'meredith-stout', name = 'Meredith Stout', what = 'night'},
}
-- Johnny's own jobs, by the quest ids in their journal paths (Chippin' In, Tapeworm, Holdin' On, A Like Supreme, the Swedenborg job).
local OWN = {'sq031', 'sq032', 'sq011', 'sq017', 'mq018'}
-- The journal types a remark is worth: main and side jobs (no gigs or NCPD scanner hustles).
local QUEST_TYPES = {MainQuest = true, SideQuest = true, MinorQuest = true}

local function clean(value, limit)
    if type(value) ~= 'string' then return nil end
    local text = value:gsub('<[^>]*>', ''):gsub('%c', ' '):gsub('%s+', ' '):match('^%s*(.-)%s*$')
    if text == '' or #text > limit or text:match('^LocKey#') then return nil end
    return text
end

-- A game-dialogue row (mod/game-dialogue.lua push) -> subject and facts of a "met someone" event, or nil. Only a named roster character
-- heard in person (a scene line), never Johnny himself, an archetype or a crowd profile. Pure.
function M.personEvent(row)
    if type(row) ~= 'table' or row.channel ~= 'scene' or row.speaker ~= 'npc' then return nil end
    local key = row.profileKey
    if type(key) ~= 'string' or not key:match('^[a-z0-9%-]+$') or key == 'johnny-silverhand'
        or key:match('^npc%-') or key:match('^resident%-') then return nil end
    local name = clean(row.name, 60)
    if not name then return nil end
    return 'person:' .. key, {name = name, profileKey = key}
end

-- A quest the history scan newly found finished (mod/journal-history.lua onFinished) -> subject and facts, or nil. Pure.
function M.questEvent(quest)
    if type(quest) ~= 'table' or (quest.state ~= 'succeeded' and quest.state ~= 'failed') then return nil end
    if quest.questType ~= nil and not QUEST_TYPES[quest.questType] then return nil end
    local title = clean(quest.title, 160)
    if not title then return nil end
    local mine = false
    if type(quest.nativePath) == 'string' then
        for _, id in ipairs(OWN) do if quest.nativePath:find(id, 1, true) then mine = true end end
    end
    return 'quest:' .. tostring(quest.id or title), {title = title, outcome = quest.state, mine = mine}
end

-- A romance fact that just became set (mod/relationship-state.lua onFact) -> subject and facts, or nil. Pure.
function M.romanceEvent(fact)
    local row = M.ROMANCES[fact]
    if not row then return nil end
    return 'romance:' .. row.who, {name = row.name, profileKey = row.who, what = row.what}
end

-- The places he speaks up about, by the gamedataDistrict records that put V there (the enum names of tweakDBEnums.script and the parent
-- chain of the District records, research/cyberpunk/native-reviews/johnny-places-20261019.json, which lists the sources of every row).
-- The key is what the bridge words (bridge/johnny-head.mjs PLACES: the phrase, his note, and the note for a save that has what the
-- game's own rule needs). A venue is one record; a district is any record under it, so the most specific place on V's chain wins.
--   cooldown  seconds before the same place again (3 to 8 hours: a place V visits all the time is not remarked on every time)
--   vehicle   false: a reading while V is mounted in a vehicle is not being there (an interior or an estate whose volume may reach the
--             street), so the arrival is the first reading on foot; true: driving in counts
--   alt       what the save must have for the bridge's second note: every fact set (>= 1) and every journal entry succeeded, the
--             condition of the knowledge rule that backs the note (read once, when the arrival is noted)
M.PLACE_SECONDS = 6
M.PLACES = {
    {key = 'afterlife', districts = {'LittleChina_Afterlife'}, cooldown = 4 * 3600, vehicle = false,
        alt = {facts = {'q103_rogue_paid_up', 'q103_rogue_done'}}},
    {key = 'arasaka-tower', cooldown = 6 * 3600, vehicle = true,
        districts = {'CorpoPlaza', 'CorpoPlaza_ArasakaTowerLobby', 'CorpoPlaza_ArasakaTowerJungle', 'CorpoPlaza_ArasakaTowerAtrium',
            'CorpoPlaza_ArasakaTowerNest', 'CorpoPlaza_ArasakaTowerSaburoOffice', 'CorpoPlaza_ArasakaTowerJenkins',
            'CorpoPlaza_ArasakaTowerUnlistedFloors', 'CorpoPlaza_ArasakaTowerUpperAtrium', 'CorpoPlaza_ArasakaTowerCEOFloor'},
        alt = {facts = {'q101_rogue_moved_to_heli'},
            journal = {{path = 'quests/main_quest/act_01/q101_01_firestorm', class = 'gameJournalQuest'}}}},
    {key = 'embers', districts = {'Glen_Embers'}, cooldown = 3 * 3600, vehicle = false,
        alt = {journal = {{path = 'quests/meta/02_sickness/q115/04_talk_hanako', class = 'gameJournalQuestObjective'}}}},
    {key = 'pacifica', districts = {'Pacifica'}, cooldown = 6 * 3600, vehicle = true},
    {key = 'badlands', districts = {'Badlands', 'NorthBadlands', 'SouthBadlands'}, cooldown = 8 * 3600, vehicle = true},
    {key = 'oil-field', districts = {'Badlands_NorthSunriseOilField'}, cooldown = 3 * 3600, vehicle = true},
    {key = 'dogtown', districts = {'Dogtown', 'Dogtown_Brooklyn'}, cooldown = 6 * 3600, vehicle = true,
        alt = {facts = {'q301_sb_agreed'},
            journal = {{path = 'ep1/quests/main_quest/q301_crash/00_hook/talk_songbird', class = 'gameJournalQuestObjective'}}}},
    {key = 'viktors-clinic', districts = {'LittleChina_VictorsClinic'}, cooldown = 6 * 3600, vehicle = false},
    {key = 'kerry-estate', districts = {'NorthOaks_Kerry_Estate'}, cooldown = 3 * 3600, vehicle = false,
        alt = {journal = {{path = 'quests/side_quest/sq011_kerry', class = 'gameJournalQuest'}}}},
    {key = 'denny-estate', districts = {'NorthOaks_Denny_Estate'}, cooldown = 3 * 3600, vehicle = false},
    {key = 'totentanz', districts = {'Northside_Totentaz'}, cooldown = 3 * 3600, vehicle = false,
        alt = {journal = {{path = 'quests/side_quest/sq011_johnny/04_nancy', class = 'gameJournalQuestPhase'}}}},
}
local PLACE_BY_DISTRICT = {}
for _, row in ipairs(M.PLACES) do
    for _, name in ipairs(row.districts) do PLACE_BY_DISTRICT[name] = row end
end

-- chain: the record names V is in, the most specific first (init.lua resolves it only when the district changes). The most specific
-- place on the list, or nil. Pure.
function M.placeOf(chain)
    if type(chain) ~= 'table' then return nil end
    for index = 1, math.min(#chain, 8) do
        local row = PLACE_BY_DISTRICT[chain[index]]
        if row then return row end
    end
    return nil
end

-- A place row (M.placeOf) -> subject, facts and its cooldown, or nil. The bridge words the key; nothing else travels (init.lua adds
-- alt = true when M.altMet says the save has what the second note needs). Pure.
function M.placeEvent(row)
    if type(row) ~= 'table' or type(row.key) ~= 'string' or PLACE_BY_DISTRICT[row.districts and row.districts[1]] ~= row then return nil end
    return 'place:' .. row.key, {place = row.key}, row.cooldown
end

-- Does the save have what the row's second note needs (row.alt: every fact set, every journal entry succeeded)? The readers are the
-- game's (init.lua): readFact(name) -> number, readJournal(path, class) -> 'succeeded' or something else. A failed or missing read is
-- not met, so the plain note is said, never the one that needs more. false for a row with no alt. Pure given the readers.
function M.altMet(row, readFact, readJournal)
    local alt = type(row) == 'table' and row.alt or nil
    if type(alt) ~= 'table' then return false end
    for _, name in ipairs(alt.facts or {}) do
        local ok, value = pcall(readFact, name)
        if not ok or type(value) ~= 'number' or value ~= value or value < 1 then return false end
    end
    for _, entry in ipairs(alt.journal or {}) do
        local ok, state = pcall(readJournal, entry.path, entry.class)
        if not ok or state ~= 'succeeded' then return false end
    end
    return true
end

-- Arrivals, from successive readings of V's chain. A place counts once it is read twice in a row (a district edge crossed for a moment
-- is not an arrival), and the first reading of a world is where V already was (a save load or a fast travel's load is not an arrival).
-- mounted: V is in a vehicle; a place with vehicle = false does not count while V is (the first reading on foot is the arrival).
-- observe returns the place row on an arrival, else nil. Pure.
function M.placeTracker()
    local tracker, current, candidate, baseline = {}, nil, nil, true
    function tracker:observe(chain, mounted)
        local row = M.placeOf(chain)
        if row and row.vehicle == false and mounted == true then row = nil end
        local key = row and row.key or false
        if baseline then baseline, current, candidate = false, key, nil; return nil end
        if key == current then candidate = nil; return nil end
        if key ~= candidate then candidate = key; return nil end
        current, candidate = key, nil
        return row or nil
    end
    function tracker:reset() current, candidate, baseline = nil, nil, true end
    return tracker
end

-- options.level(): 'off', 'rare' or 'normal'. Times are os.time seconds, passed in.
function M.new(options)
    options = type(options) == 'table' and options or {}
    local service = {queue = {}, said = {}, subjects = {}, cooldowns = {}}

    local function level() local ok, value = pcall(options.level); return ok and M.LEVELS[value] or nil end

    -- Keep an event (kind: 'person', 'quest', 'romance', 'place'). A person heard again refreshes the event, so the remark waits until a
    -- while after their last line. cooldown: seconds before the same subject again once remarked on (a place's own; else an hour). False
    -- when the select is Off, the subject is still cooling down, or the event is malformed.
    function service:note(kind, subject, facts, now, cooldown)
        if not level() or not M.TTL[kind] or type(subject) ~= 'string' or type(facts) ~= 'table' or type(now) ~= 'number' then return false end
        local last = self.subjects[subject]
        if last and now - last < (self.cooldowns[subject] or M.SUBJECT_SECONDS) then return false end
        for _, entry in ipairs(self.queue) do
            if entry.subject == subject then entry.heardAt, entry.facts = now, facts; return true end
        end
        if #self.queue >= M.MAX_QUEUE then table.remove(self.queue, 1) end
        self.queue[#self.queue + 1] = {kind = kind, subject = subject, facts = facts, at = now, heardAt = now,
            cooldown = type(cooldown) == 'number' and cooldown > 0 and cooldown or nil}
        return true
    end

    -- Anything waiting at all (one length check: the 0.1 s tick asks this before anything else).
    function service:pending() return #self.queue > 0 end

    -- The rate limit: the gap since the last remark heard, and the count in the last hour.
    function service:allowed(now)
        local cfg = level()
        if not cfg then return false end
        local recent = 0
        for index = #self.said, 1, -1 do
            local at = self.said[index]
            if now - at < 3600 then recent = recent + 1 else table.remove(self.said, index) end
        end
        local last = self.said[#self.said]
        return recent < cfg.hour and (not last or now - last >= cfg.gap)
    end

    -- The remark to speak now, or nil: expired events are dropped first; then the oldest event past its quiet time, if the rate allows.
    function service:offer(now)
        for index = #self.queue, 1, -1 do
            local entry = self.queue[index]
            if now - entry.heardAt > M.TTL[entry.kind] then table.remove(self.queue, index) end
        end
        if not self:allowed(now) then return nil end
        for _, entry in ipairs(self.queue) do
            if now - entry.heardAt >= M.QUIET_SECONDS then return entry end
        end
        return nil
    end

    -- The remark was sent: it leaves the queue, its subject cools down and it counts towards the rate.
    function service:claim(entry, now)
        for index, other in ipairs(self.queue) do
            if other == entry then table.remove(self.queue, index); break end
        end
        self.subjects[entry.subject], self.cooldowns[entry.subject] = now, entry.cooldown
        self.said[#self.said + 1] = now
        entry.claimedAt, self.current = now, entry
        return true
    end

    -- The remark ended. One nobody heard (refused, failed, cut before a word) gives its rate slot back; its subject stays cooled down.
    function service:release(entry, heard)
        if entry ~= nil and entry == self.current then self.current = nil end
        if heard or type(entry) ~= 'table' or not entry.claimedAt then return end
        for index = #self.said, 1, -1 do
            if self.said[index] == entry.claimedAt then table.remove(self.said, index); return end
        end
    end

    -- A world change (save load) forgets the queue; what was said and the subjects stay (they are real time, not save time).
    function service:reset() self.queue = {} end
    return service
end

return M
