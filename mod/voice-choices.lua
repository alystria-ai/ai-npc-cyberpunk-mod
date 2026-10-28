-- Speak dialogue choices (Settings > Voices, off by default; docs/VOICE_CHOICES.md): while the game shows its own dialogue choice list, the player can SAY a
-- choice and it is picked. This is the game half. It does three small things, all driven by the game's own events, never per frame:
--   1. When the list opens, changes or closes (the HUD's OnDialogsData, OnDialogsActivateHub and OnDialogsSelectIndex events) it publishes the visible captions, the
--      highlighted line and a fingerprint of the list in runtime/choice-hub.json, and asks the bridge's microphone to listen while the list is open.
--   2. The bridge hears the player (its voice activity detector), recognises the words, matches them to a caption (bridge/voice-choice-match.mjs, no language
--      model), moves the highlight with the arrow keys and applies it with Enter (bridge/choice-keys.py). None of that runs here.
--   3. While the list is open, runtime/choice-result.json is read four times a second; when the bridge could not pick (the words fit no caption, or two) one
--      short notice says so. A list that is not on screen costs nothing.
-- The same setting off: the observers still exist once registered (CET cannot remove them) but their first line returns, and the microphone is released.
local M = {}
M.clock = os.clock

local HUB_PATH, RESULT_PATH = 'runtime/choice-hub.json', 'runtime/choice-result.json'
local MAX_HUBS, MAX_CHOICES, MAX_TEXT = 8, 12, 400
local POLL_S = 0.25          -- how often the result file is looked at, only while a list is on screen
local NOTICE_GAP_S = 3       -- one notice per this many seconds, however many lines the player says

local state = {
    installed = false, open = false, fp = '', hubId = nil, texts = {}, selected = nil, hubs = nil, activeId = nil,
    seq = 0, written = nil, openedAt = 0, polledAt = -100, seen = nil, noticeAt = -100, unavailableShown = false,
}

-- deps (set by init.lua once):
--   enabled()                 the setting
--   observe(class, method, fn) a CET ObserveAfter
--   hubsNow()                 the DialogChoiceHubs value on the blackboard right now (a list that was already open when the setting went on), or nil
--   activeHub()               ActiveChoiceHubID, or nil
--   selectedIndex()           the highlighted line (SelectedIndex, 0-based), or nil
--   localized(text)           a LocKey# placeholder resolved, other text unchanged
--   unavailable(choice)       true when the game marks the line unusable (greyed out: Inactive, CheckFailed), so it is never picked
--   write(path, text)         true when written
--   read(path)                the text of a small file, or nil
--   listen(on)                the bridge's microphone for the list (mod/microphone.lua listenChoice)
--   notice(kind)              'unclear' | 'ambiguous' | 'unavailable'
--   log(line)
M.deps = nil

local function now() return M.clock() end

-- Game text as the player reads it: placeholders resolved, markup and control characters gone, one space between words, cut on a character boundary.
local function plain(value)
    if type(value) ~= 'string' then return '' end
    local text = value:gsub('<[^>]*>', ''):gsub('%c', ' '):gsub('%s+', ' '):match('^%s*(.-)%s*$')
    if text == '' or text:match('^LocKey#') then return '' end
    if #text > MAX_TEXT then
        local cut = MAX_TEXT
        while cut > 0 and text:byte(cut + 1) and text:byte(cut + 1) >= 0x80 and text:byte(cut + 1) < 0xC0 do cut = cut - 1 end
        text = text:sub(1, cut)
    end
    return text
end

-- A short fingerprint of a list: its hub, its size and its captions. The bridge refuses to press a key for a list whose fingerprint is not the one it matched.
function M.fingerprint(hubId, texts)
    local h = 5381
    local joined = tostring(hubId) .. '|' .. #texts .. '|' .. table.concat(texts, '\1')
    for index = 1, #joined do h = (h * 33 + joined:byte(index)) % 2147483629 end
    return string.format('%d:%d:%08x', tonumber(hubId) or -1, #texts, h)
end

-- The plain strings of the hubs in an OnDialogsData value: {{id =, texts = {...}}, ...}. Greyed-out lines keep their place with an empty caption.
local function readHubs(data)
    local deps = M.deps
    local hubs = {}
    local list = data.choiceHubs or {}
    for index = 1, math.min(#list, MAX_HUBS) do
        local hub = list[index]
        local row = {id = tonumber(hub.id), texts = {}}
        local choices = hub.choices or {}
        for choice = 1, math.min(#choices, MAX_CHOICES) do
            local item = choices[choice]
            local text = plain(deps.localized(item.localizedName))
            if text ~= '' then
                local ok, off = pcall(deps.unavailable, item)
                if ok and off == true then text = '' end
            end
            row.texts[choice] = text
        end
        hubs[#hubs + 1] = row
    end
    return hubs
end

-- The hub the player is choosing from: the active one, else the first with lines.
local function activeHub(hubs, activeId)
    if not hubs then return nil end
    for _, hub in ipairs(hubs) do
        if activeId ~= nil and hub.id == activeId and #hub.texts > 0 then return hub end
    end
    for _, hub in ipairs(hubs) do
        if #hub.texts > 0 then return hub end
    end
    return nil
end

-- Writes runtime/choice-hub.json (and the microphone request) when what the bridge needs to know has changed. Called by events only.
local function publish()
    local deps = M.deps
    if not deps then return end
    local hub = deps.enabled() and state.hubs and activeHub(state.hubs, state.activeId) or nil
    local open = hub ~= nil
    local texts = hub and hub.texts or {}
    local fp = open and M.fingerprint(hub.id, texts) or ''
    local selected = open and state.selected or nil
    if selected ~= nil and (selected < 0 or selected >= #texts) then selected = nil end
    local key = tostring(open) .. '|' .. fp .. '|' .. tostring(selected)
    if key == state.written then return end
    state.written = key
    if open and not state.open then state.openedAt = os.time() * 1000 end
    state.open, state.fp, state.hubId, state.texts = open, fp, hub and hub.id or nil, texts
    state.seq = state.seq + 1
    local ok, raw = pcall(json.encode, open and {n = state.seq, open = true, fp = fp, hubId = hub.id, selected = selected, texts = texts}
        or {n = state.seq, open = false, fp = ''})
    if ok then deps.write(HUB_PATH, raw) end
    deps.listen(open)
    if open then state.polledAt = now() end
end

local function guard(fn)
    return function(...)
        local deps = M.deps
        if not deps or not deps.enabled() then return end
        local ok, err = pcall(fn, ...)
        if not ok and deps.log then deps.log('Speak dialogue choices: ' .. tostring(err)) end
    end
end

-- Registers the events once (the first time the setting is on). A list that is already open is read right away.
-- OnDialogsData is the HUD base class's; the highlight and hub events are on the dialogue widget (a subclass), so each one is tried on both classes: an
-- observer the game does not have is logged and skipped, never an error, and the list is still followed by the 0.1 s check in tick().
local function observeBoth(method, fn)
    local deps = M.deps
    local seen = false
    for _, class in ipairs({'InteractionUIBase', 'dialogWidgetGameController'}) do
        local ok, err = pcall(deps.observe, class, method, fn)
        if ok then seen = true elseif deps.log then deps.log('Speak dialogue choices: ' .. class .. '.' .. method .. ' not observed (' .. tostring(err):sub(1, 80) .. ')') end
    end
    return seen
end

function M.install()
    local deps = M.deps
    if state.installed or not deps then return end
    state.installed = true
    observeBoth('OnDialogsData', guard(function(_, value)
        local data = FromVariant(value)
        state.hubs = (type(data) == 'table' or type(data) == 'userdata') and readHubs(data) or nil
        state.activeId = deps.activeHub()
        state.selected = deps.selectedIndex() or state.selected
        publish()
    end))
    observeBoth('OnDialogsActivateHub', guard(function(_, id)
        state.activeId = tonumber(id) or deps.activeHub()
        state.selected = deps.selectedIndex() or state.selected
        publish()
    end))
    observeBoth('OnDialogsSelectIndex', guard(function(_, index)
        state.selected = tonumber(index)
        publish()
    end))
    local ok = pcall(function()
        local data = deps.hubsNow()
        if data ~= nil then
            state.hubs = readHubs(data)
            state.activeId = deps.activeHub()
            state.selected = deps.selectedIndex()
            publish()
        end
    end)
    if not ok and deps.log then deps.log('Speak dialogue choices: the list on screen could not be read') end
end

-- The setting went off (or the world went away): the list is forgotten, the file says closed and the bridge releases the microphone. Idempotent.
function M.off()
    local deps = M.deps
    if not deps then return end
    state.hubs = nil
    if state.written == nil or state.written:sub(1, 5) == 'false' then return end
    publish()
end

-- The notice for a result the bridge wrote, if any. status: pick (nothing to say), ambiguous, none, unavailable, error (nothing to say).
local KIND = {ambiguous = 'ambiguous', none = 'unclear', unavailable = 'unavailable'}
local function showResult(raw)
    local deps = M.deps
    local ok, result = pcall(json.decode, raw)
    if not ok or type(result) ~= 'table' or type(result.id) ~= 'string' or result.id == state.seen then return end
    state.seen = result.id
    -- Only an answer about the list on screen now, given after it opened; an old file says nothing.
    if result.fp ~= state.fp or (tonumber(result.at) or 0) < state.openedAt - 1500 then return end
    local kind = KIND[result.status]
    if not kind then return end
    if kind == 'unavailable' then
        if state.unavailableShown then return end
        state.unavailableShown = true
    end
    local t = now()
    if t - state.noticeAt < NOTICE_GAP_S then return end
    state.noticeAt = t
    deps.notice(kind)
end

-- Called from the game's 10 Hz tick. One boolean while the setting is off; nothing while no list is on screen.
function M.tick()
    local deps = M.deps
    if not deps then return end
    if not deps.enabled() then
        if state.installed then M.off() end
        return
    end
    if not state.installed then M.install() end
    if not state.open then return end
    local t = now()
    -- The highlight and the active hub, straight from the blackboard, every tick while a list is on screen (the events say the same sooner; this keeps the
    -- bridge right if one of them is missed). Two integer reads at 10 Hz, only while a list is open.
    local okRead, sel, active = pcall(function() return deps.selectedIndex(), deps.activeHub() end)
    if okRead then
        local changed = false
        if type(sel) == 'number' and sel ~= state.selected then state.selected, changed = sel, true end
        if type(active) == 'number' and active ~= state.activeId then state.activeId, changed = active, true end
        if changed then publish() end
    end
    if t - state.polledAt < POLL_S then return end
    state.polledAt = t
    local raw = deps.read(RESULT_PATH)
    if raw and raw ~= '' then showResult(raw) end
end

function M.status() return {open = state.open, fp = state.fp, selected = state.selected, count = #state.texts, installed = state.installed} end

return M
