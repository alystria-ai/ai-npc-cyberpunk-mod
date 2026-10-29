local convaiPlayer = convaiPlayer or function() return Game.GetPlayer() end
-- Read only the tracked quest and active objectives already revealed in this save.
-- Native journal handles remain local to a capture, never across frames or loads.
local M = convaiQuestContext or {}
local MAX_NODES, MAX_DEPTH, MAX_OBJECTIVES = 128, 8, 8

local function localized(key, limit)
    local text = GetLocalizedText(key)
    if type(text) ~= 'string' then return '' end
    text = text:gsub('<[^>]*>', ''):gsub('%c', ' '):gsub('%s+', ' '):match('^%s*(.-)%s*$')
    -- Reject missing localization keys and oversized entries rather than cut UTF-8.
    if #text > limit or text:match('^LocKey#') then return '' end
    return text
end

function M.readJournal(journal)
    local tracked = journal:GetTrackedEntry()
    if not tracked then return {version = 1, status = 'untracked'} end
    local active = Enum.new('gameJournalEntryState', 'Active')
    if journal:GetEntryState(tracked) ~= active then return {version = 1, status = 'untracked'} end
    local trackedId = tostring(journal:GetEntryHash(tracked))
    local entry, quest, ancestors = tracked, nil, {}
    for _ = 1, 12 do
        if not entry then break end
        local hash = tostring(journal:GetEntryHash(entry))
        if ancestors[hash] then break end
        ancestors[hash] = true
        if entry:IsA('gameJournalQuest') then quest = entry; break end
        entry = journal:GetParentEntry(entry)
    end
    if not quest or journal:GetEntryState(quest) ~= active then
        return {version = 1, status = 'unavailable'}
    end
    local title = localized(quest:GetTitle(journal), 320)
    if title == '' then return {version = 1, status = 'unavailable'} end
    local result = {version = 1, status = 'active', quest = {
        id = tostring(journal:GetEntryHash(quest)), title = title, objectives = {}}}
    local filter = JournalRequestStateFilter.new({inactive = false, active = true, succeeded = false, failed = false})
    local seen, emitted, count = {}, {}, 0
    local function addObjective(objective)
        local id = tostring(journal:GetEntryHash(objective))
        if emitted[id] or #result.quest.objectives >= MAX_OBJECTIVES then return end
        -- Check again even when GetChildren has already applied the state filter.
        if journal:GetEntryState(objective) ~= active or not objective:IsA('gameJournalQuestObjectiveBase') then return end
        local text = localized(objective:GetDescription(), 1200)
        if text == '' then return end
        local row = {id = id, text = text, tracked = id == trackedId}
        local optionalOk, optional = pcall(function() return journal:GetIsObjectiveOptional(objective) end)
        if optionalOk and type(optional) == 'boolean' then row.optional = optional end
        if objective:HasCounter() then
            local counterOk, current, total = pcall(function()
                return journal:GetObjectiveCurrentCounter(objective), journal:GetObjectiveTotalCounter(objective)
            end)
            if counterOk and type(current) == 'number' and type(total) == 'number'
                and current >= 0 and total > 0 and current <= total and total <= 1000000 then
                row.current, row.total = current, total
            end
        end
        emitted[id] = true
        result.quest.objectives[#result.quest.objectives + 1] = row
    end
    -- Prioritize the tracked objective even when the visible tree is large.
    addObjective(tracked)
    local function visit(node, depth)
        if depth > MAX_DEPTH or count >= MAX_NODES or #result.quest.objectives >= MAX_OBJECTIVES then return end
        local id = tostring(journal:GetEntryHash(node))
        if seen[id] or journal:GetEntryState(node) ~= active then return end
        seen[id], count = true, count + 1
        addObjective(node)
        if not node:IsA('gameJournalQuest') and not node:IsA('gameJournalQuestPhase')
            and not node:IsA('gameJournalQuestObjectiveBase') then return end
        local first, second = journal:GetChildren(node, filter)
        local children = type(second) == 'table' and second or first
        assert(type(children) == 'table', 'Journal child array unavailable')
        for index = 1, math.min(#children, MAX_NODES) do visit(children[index], depth + 1) end
    end
    visit(quest, 0)
    return result
end

-- Just the tracked quest's id and title (the decision ledger stamps a pick with it). Read once per picked dialogue option, never per
-- frame; nil when nothing active is tracked or any read fails.
function M.trackedQuest()
    local ok, result = pcall(function()
        local journal = Game.GetJournalManager()
        local tracked = journal:GetTrackedEntry()
        if not tracked then return nil end
        local active = Enum.new('gameJournalEntryState', 'Active')
        local entry, quest = tracked, nil
        for _ = 1, 12 do
            if not entry then break end
            if entry:IsA('gameJournalQuest') then quest = entry; break end
            entry = journal:GetParentEntry(entry)
        end
        if not quest or journal:GetEntryState(quest) ~= active then return nil end
        local title = localized(quest:GetTitle(journal), 320)
        if title == '' then return nil end
        return {id = tostring(journal:GetEntryHash(quest)), title = title}
    end)
    return ok and result or nil
end

function M.capture()
    local ok, result = pcall(function()
        local player = convaiPlayer()
        if not player or not player:IsAttached() or player:IsDeadNoStatPool()
            or Game.GetSystemRequestsHandler():IsPreGame() then
            return {version = 1, status = 'unavailable'}
        end
        return M.readJournal(Game.GetJournalManager())
    end)
    M.lastError = not ok and tostring(result) or nil
    return ok and result or {version = 1, status = 'unavailable'}
end

convaiQuestContext = M
return M
