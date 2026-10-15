-- MCM API v2 provider. Every control is rendered by the installed native
-- settings framework. No ImGui panel or copied MCM implementation.
local M = {}
local ui = (convaiUiLocale or dofile('ui-locale.lua'))
local PROVIDER, MOD, LABEL = 'cyberpunk-convai', 'manager', 'Companion Manager'
local MOD_KEY, MODEL_PAGE_SIZE = PROVIDER .. ':' .. MOD, 18
local manager, queue, entry, api, provider
local view, modelQuery, modelPage = 'home', '', 1
local actions, hooksInstalled, refreshQueued = {}, false, false
local owner, lastSignature, pollAt, searchFrames, snapshotAt = nil, '', 0, 0, 0
-- What the page that is on screen was built from (pageSignature) and what the last once-a-second look found. The page is
-- drawn again when they differ, or when something forces it (refreshQueued: a language change, a Back, a new save ...).
local renderedSignature = ''
local lastError = ''
local actionFeedback, memoryActionCommand
local preparationTarget, preparationStatus, preparationActionFeedback
local preparationAt = 0
local presentation = {active = false, rows = {}}
local voiceSelectors = {}
-- The Companion voices menu of the page on screen: how many entries it has (Inworld is listed only in developer mode), which of them
-- are greyed out (OmniVoice while its pack is not installed), their texts, and a select whose value text has to be dimmed or put back
-- (set by an observer, done in M.update: the widgets are never touched inside a hook).
local voiceMenuSize, voiceDisabled, voiceLabelsShown, voiceDimController = 0, {}, {}, nil
local renderOwn = false   -- the page MCM is drawing now is ours (set by the McmUiBegin override)
-- Everything that does not need a frame runs on this tick (see M.update). A queue
-- change, a session reset and the return to gameplay run it on the next frame.
local SLOW_PERIOD = 0.25
local slowAt, flushDue, lastWorldReady = 0, false, nil
local localeRevision = -1
-- Every setting on this provider waits for an explicit Apply, like the game's own
-- Settings pages. MCM's Auto Apply preference (a global player choice we must not
-- change) would commit each edit at once: it sets the draft and calls apply in the
-- same call. That call is recognised by the draft event that precedes it by a few
-- microseconds, and refused, so MCM keeps its own pending drafts: the native
-- changed-row markers, the Revert and Apply buttons, Defaults, the unsaved-changes
-- prompt when leaving, and the close guard. A person's Apply comes much later.
local AUTO_APPLY_WINDOW = 0.25
local lastDraftEventAt = -1000
local lastBackAt = -1000
-- Mature content (see syncMature): a draft change only sets matureCheck in its callback; the work is done by M.update.
-- matureReset: the drafts are all gone (Apply or Revert). matureSeen: the Mature content value last looked at (nil: take the saved
-- one). matureMemory: what turning it on changed in the drafts, to put back if it is turned off before Apply. matureChanges: the
-- names of what the last change staged or put back, for inspect() only: nothing is shown to the player (no notice on either side).
local matureCheck, matureReset, matureSeen, matureMemory, matureChanges = false, false, nil, nil, nil
-- providerSeen: the Conversation provider draft last looked at (nil: take the saved one), so picking a cloud provider while Mature
-- content is on can be told from any other draft change.
local providerSeen
-- The Companion voices list (menu order) lives with the draft preview: Pocket TTS, OmniVoice 16/32 steps with a
-- short or long reference, Convai cloud voice.
local voicePreviewModule = dofile('voice-preview.lua')
local VOICE_CHOICES = voicePreviewModule.CHOICES
-- No voice model is prepared from a draft: nothing reaches the conversation
-- service until Apply.
local voicePreview = voicePreviewModule.new()
-- Back is a native button in MCM's bottom action row, laid out with Revert, Apply,
-- Defaults and Modified. MCM has no provider API for that row, so after each render
-- the button is added and the others are shifted to make room. If it cannot be
-- added, Back becomes the last row of the page instead.
local BACK_ID = 'convai-bottom-back'
local BAR_GAP = 20
local backMode, currentBack = 'bottom', nil
local statusOriginal
-- A value change (a slider or option, a toggle) makes MCM draw the WHOLE page again from its own update, which runs after ours
-- in the frame: the new rows, status line and buttons would show in MCM's default look for at least one frame before this
-- module can style them. So the page's content is created hidden, in the same call that creates it (the McmUiBeginContent
-- override below changes only its contentReady argument, no widget is touched), and shown again once it is styled
-- (unveilPage). contentHold remembers the hold: {controller, at}. It is cleared when the content is shown, and a hold that
-- nothing released within HOLD_MAX seconds (a style job that never started) is released by M.update, so the page can never
-- stay empty.
local contentHold, holdDisabled
local HOLD_MAX = 1.5
-- The scroll position of the content survives a redraw. MCM captures it before it draws and hands it to McmUiBeginContent,
-- which sets it on the new, still empty scroll area; a page created hidden (contentHold) or drawn after a capture that MCM
-- skipped came back at the top. So the position is remembered for the page being drawn (scrollBefore: read once from the old page
-- in McmUiBegin, only when the page is the one drawn last, lastDrawKey) and set again on the wrapper's scroll controller in the
-- same call that shows the content, when it is not already there.
local lastDrawKey, scrollBefore
local scrollLogBudget = 12
local function pageKey() return view .. '|' .. tostring(modelPage) .. '|' .. tostring(modelQuery) end
-- The refusal MCM shows when a change would be applied automatically. It goes to
-- MCM's status line, which is moved to the top of the content column.
local function hintPending() return ui.t('Change pending. Choose Apply to use it, or Revert to discard it.') end
local CONTENT_FONT_SIZE = 22
-- Help page: log locations and the shareable support report. Optional: the
-- manager works without it, and a load failure only hides the Help entry.
local support, supportSignature
local supportLoaded, supportFactory = pcall(dofile, 'support-report.lua')
-- Edit characters: opens the character editor page in the player's browser. Optional like Help: without it the row is not shown.
local editor
local editorLoaded, editorFactory = pcall(dofile, 'character-editor.lua')
-- Convai paid tier (docs/CONVAI_PAID_TIER.md): its own page under Settings > Conversation provider. Optional like Help: without the file
-- the entry is not shown. paidNotice: the notice of a confirmed (or unconfirmed) purchase, held until gameplay.
local paidTier, paidNotice
local paidTierLoaded, paidTierFactory = pcall(dofile, 'convai-paid-tier.lua')
local log = function(message)
    local file = io.open('runtime/mcm.log', 'a')
    if file then file:write(os.date('!%Y-%m-%dT%H:%M:%SZ'), ' ', message, '\n'); file:close() end
    print('[CyberpunkConvai] ' .. message)
end

-- The slow components whose loading is announced (convaiNotices.loading, mod/notices.lua), in the order their lines show, and the
-- line of each state. A state other than 'loading' and 'ready' is a failure: the line says what to do.
-- The prep keys are the companions still being prepared (invitation board, manager-party.lua waiting()): one line each, in the
-- same notice, with the text of what each waits for ("Preparing Evelyn: waiting for the voice model to load…"). They are
-- loading until the companion has spawned or failed (a failure is its own notice) and have no ready line: "joined" is that.
local PREP_KEYS = {'prep1', 'prep2', 'prep3'}
local LOAD_KEYS = {'omni', 'pocket', 'local-ai', 'prep1', 'prep2', 'prep3'}
local prepText, prepRevisions, loadBoard = {}, {}, nil
local function loadingText(key, state)
    if prepText[key] then return prepText[key] end
    if key == 'omni' then
        if state == 'loading' then return ui.t('Loading the OmniVoice voice…') end
        if state == 'ready' then return ui.t('OmniVoice voice is ready.') end
        return ui.t('OmniVoice could not load. See Help in Settings.')
    elseif key == 'pocket' then
        if state == 'loading' then return ui.t('Loading the Pocket voice…') end
        if state == 'ready' then return ui.t('Pocket voice is ready.') end
        return ui.t('Pocket could not load. See Help in Settings.')
    end
    if state == 'loading' then return ui.t('Local AI is warming up…') end
    if state == 'ready' then return ui.t('Local AI is ready.') end
    if state == 'no-memory' then return ui.t('Not enough graphics memory for Local AI. A cloud provider is used instead.') end
    return ui.t('Local AI could not start. Check Local AI in Settings > Conversation provider.')
end

-- The states the loading notice reads: the slow components (manager.loadStatus) and the companions still being prepared.
-- Read by the notice at most once a second while nothing loads, a few times a second while something does.
local function readLoads()
    local states = manager.loadStatus()
    if type(states) ~= 'table' then states = {} end
    local waiting = loadBoard and type(loadBoard.waiting) == 'function' and loadBoard.waiting() or {}
    for index, key in ipairs(PREP_KEYS) do
        local line = waiting[index]
        states[key] = line and 'loading' or nil
        prepText[key], prepRevisions[key] = line and line.text or nil, line and line.text or nil
    end
    states.revisions = prepRevisions
    return states
end

local function player()
    local ok, value = pcall(function() return Game.GetPlayer() end)
    return ok and value or nil
end

local function identity(value)
    if not value then return nil end
    local ok, hash = pcall(function() return tostring(value:GetEntityID().hash) end)
    return ok and hash or nil
end

local function active()
    if not api then return false end
    local ok, data = pcall(api.getDiagnostics)
    return ok and data and data.activeModKey == MOD_KEY
end

-- MCM's getDiagnostics deep-copies its providers, errors and history (about
-- 0.27 ms a call), and the per-frame update asked it on every frame (about
-- 12 ms of each second, perf probe 2026-10-11). The hooks below already say
-- when our page is shown (presentation.active/pending), so while it is shown
-- the answer is re-read every 0.25 s, and while it is not every second (the
-- page can only have opened without our hooks before they were installed).
-- Observers keep calling active() directly.
local shownReadAt, shownLast, closedReadAt, closedLast = nil, false, nil, false
local function activeForUpdate(shown)
    local now = os.clock()
    if shown then
        if shownReadAt and now >= shownReadAt and now - shownReadAt < 0.25 then return shownLast end
        shownReadAt, shownLast = now, M.activeCheck()
        return shownLast
    end
    shownReadAt = nil
    if closedReadAt and now >= closedReadAt and now - closedReadAt < 1 then return closedLast end
    closedReadAt, closedLast = now, M.activeCheck()
    return closedLast
end

-- Only the Settings page with the interface-language list shows native language
-- names (their own font); the other pages need no font pass when the
-- interface language is a Latin one (mcm-fonts.lua).
local fontPresentation = dofile('mcm-fonts.lua').new({ui = ui, active = active,
    label = function() return ui.t(LABEL) end,
    contentMayNeedFonts = function() return view == 'settings' end})

local function controllerKey(controller)
    if not controller then return nil end
    -- Each native callback receives a new CET WeakReference wrapper. Match
    -- the engine identity, as MCM does, rather than comparing those wrappers.
    local ok, value = pcall(CalcSeed, controller)
    if ok and value ~= nil then return tostring(value) end
end

local function ownsPresentation(controller)
    return presentation.controllerKey ~= nil and presentation.controllerKey == controllerKey(controller)
end

local function findWidget(root, name, depth, budget)
    budget = budget or {left = 4096}
    if not root or budget.left <= 0 then return nil end
    budget.left = budget.left - 1
    if root:GetName() == CName.new(name) then return root end
    if depth <= 0 then return nil end
    local compound, count = pcall(function() return root:GetNumChildren() end)
    if compound then
        for index = 0, math.min(count, 1200) - 1 do
            if budget.left <= 0 then return nil end
            local found = findWidget(root:GetWidgetByIndex(index), name, depth - 1, budget)
            if found then return found end
        end
    end
end

-- Native ink wrappers do not reliably expose private redscript fields.
-- The content canvas and row names are emitted by MCM's native renderer.
-- One pass over the render's chrome finds the content canvas, the status line and
-- the mod list; it stops at each of them, so rows are never walked here (the
-- earlier three depth-first searches each walked up to 4096 widgets).
local function locateRoots(controller)
    local root = controller:GetRootWidget()
    local render = findWidget(root, 'MCMRenderRoot', 18)
    if not render then return {content = findWidget(root, 'mcm_content_scroll_content', 18)} end
    local result = {render = render}
    local wanted = {{CName.new('mcm_content_scroll_content'), 'content'}, {CName.new('status'), 'status'},
        {CName.new('mcm_sidebar_scroll_content'), 'sidebar'}}
    local budget = {left = 2048}
    local function scan(widget, depth)
        if not widget or depth < 0 or budget.left <= 0 then return end
        budget.left = budget.left - 1
        local identity = widget:GetName()
        for _, pair in ipairs(wanted) do
            if identity == pair[1] then
                if not result[pair[2]] then result[pair[2]] = widget end
                return
            end
        end
        local compound, count = pcall(function() return widget:GetNumChildren() end)
        if compound then
            for index = 0, math.min(count, 1200) - 1 do
                if budget.left <= 0 then return end
                scan(widget:GetWidgetByIndex(index), depth - 1)
            end
        end
    end
    scan(render, 18)
    return result
end

local function alignLabel(widget, left)
    if not widget then return end
    local margin = widget:GetMargin()
    local extra = margin.left - left
    if extra == 0 then return end
    margin.left = left
    widget:SetMargin(margin)
    widget:SetWidth(widget:GetWidth() + extra)
end

local function redLabel(widget)
    -- The requested resting colour is MCM's default red label token, even if
    -- another row or a customized framework theme currently has a cyan tint.
    if widget then widget:BindProperty(CName.new('tintColor'), CName.new('MainColors.Red')) end
end

local function styleCategory(widget, parentLeft, parentScale, depth, budget)
    if depth <= 0 then return end
    if budget then
        budget.left = budget.left - 1
        -- A template is about ten widgets; far past its budget this is not one (the draw hooks cap their own work).
        if budget.left < -200 then error('category template is too large') end
    end
    local margin = widget:GetMargin()
    local left = parentLeft + margin.left * parentScale
    if widget:GetName() == CName.new('label') then
        -- The native category template is scaled (about 0.52 in the live
        -- default layout). Align in content coordinates, not template units.
        alignLabel(widget, margin.left + (20 - left) / parentScale)
        -- Section titles use the native white heading above its cyan rule.
        -- Only ordinary option labels use red; leave the template rule alone.
        widget:BindProperty(CName.new('tintColor'), CName.new('MainColors.White'))
        return
    end
    local scale = widget:GetScale()
    local factor = parentScale * scale.X
    if factor <= 0 then return end
    local compound, count = pcall(function() return widget:GetNumChildren() end)
    if compound then
        for index = 0, math.min(count, 100) - 1 do
            styleCategory(widget:GetWidgetByIndex(index), left, factor, depth - 1, budget)
        end
    end
end

-- Work units per frame while a freshly drawn page is styled: listing a row costs
-- 1 (three native calls), styling a row ROW_COST (about ten), a category widget 1
-- per widget visited. A page of about 100 rows takes one to three frames, and a
-- frame's batch stays near 10 ms (a whole page in one frame was 50-110 ms in the
-- 2026-10-12 capture).
local STYLE_BUDGET, ROW_COST = 300, 4

local function styleRow(row, widgets, budget)
    local widget, name = row.widget, row.name
    local managed = name:match('^(.*)_managed_label$')
    local marker = name:match('^(.*)_managed_marker$')
    local label = name:match('^(.*)_label$')
    local surface = name:match('^mcm_action_(.*)$')
    if managed then
        presentation.rows[managed] = 'managed'
        alignLabel(widget, 20)
        presentation.tint[managed] = widget
        if not presentation.hovered[managed] then redLabel(widget) end
        local draft = widgets[managed .. '_managed_marker']
        if draft then alignLabel(draft, 0); draft:SetWidth(12) end
    elseif marker then
        -- The paired managed label handles this marker. Keep its colour.
    elseif label then
        presentation.rows[label] = 'action'
        presentation.tint[label] = widget
        if not presentation.hovered[label] then redLabel(widget) end
    elseif surface and widget:GetMargin().left <= 60 then
        presentation.rows[surface] = 'readonly'
        local text = findWidget(widget, 'label', 2, {left = 30})
        alignLabel(text, 0)
        -- MCM draws read-only labels larger (26) than its setting labels (22).
        if text then pcall(function() text:SetFontSize(CONTENT_FONT_SIZE) end) end
        presentation.tint[surface] = text
        if not presentation.hovered[surface] then redLabel(text) end
    else
        local owner = widget:GetController()
        if owner and owner:IsA('SettingsCategoryController') then styleCategory(widget, 0, 1, 6, budget) end
    end
end

-- A page that was just drawn shows the framework's own look (cyan, unaligned labels) until it is styled, which takes one to
-- three frames in batches: every redraw flashed that. So the rows are hidden (opacity 0, the layout is untouched) from the
-- moment the page is found until it is styled and its fonts are in place, then shown at their own opacity. The page is never
-- hidden longer than VEIL_MAX seconds, whatever happens, and a veil on a page that was drawn again is gone with its widget.
local VEIL_MAX = 0.75

-- Puts the content back at the scroll position the page had before it was drawn again (three native calls, none when the
-- position is zero or already right). Never raises.
local function applyScroll(wrapper, want)
    want = tonumber(want)
    if not wrapper or not want or want < 0.002 then return end
    local ok, err = pcall(function()
        local scroller = wrapper:GetController()
        local current = tonumber(scroller:GetScrollPosition()) or 0
        if math.abs(current - want) > 0.002 then
            scroller:SetScrollPosition(math.min(1, want))
            if scrollLogBudget > 0 then
                scrollLogBudget = scrollLogBudget - 1
                log('Probe: scroll position restored ' .. tostring(current) .. ' -> ' .. tostring(want))
            end
        end
    end)
    if not ok and scrollLogBudget > 0 then
        scrollLogBudget = scrollLogBudget - 1
        log('Probe: scroll position could not be restored: ' .. tostring(err))
    end
end

local function veilPage(content)
    local read, opacity = pcall(function() return content:GetOpacity() end)
    if pcall(function() content:SetOpacity(0.0) end) then
        -- The scroll wrapper is two levels up (content, scroll area, wrapper); it is the widget MCM hid at creation.
        local found, wrapper = pcall(function() return content:GetParentWidget():GetParentWidget() end)
        presentation.veil = {widget = content, wrapper = found and wrapper or nil,
            opacity = read and tonumber(opacity) or 1.0, at = os.clock()}
    end
end

local function unveilPage()
    local held = presentation.veil
    if held then
        presentation.veil = nil
        pcall(function() held.widget:SetOpacity(held.opacity) end)
        if contentHold and held.wrapper and pcall(function() held.wrapper:SetVisible(true) end) then
            applyScroll(held.wrapper, contentHold.scroll)
            contentHold = nil
        end
    end
end

-- The hold of a render that was never styled (or whose wrapper could not be found) is released here: the page is found again
-- and shown. If even that fails the hold is switched off for the session and the page drawn again without it.
local function releaseStaleHold()
    local hold = contentHold
    if not hold or os.clock() - hold.at < HOLD_MAX then return end
    contentHold = nil
    local shown = pcall(function()
        local wrapper = locateRoots(hold.controller).content:GetParentWidget():GetParentWidget()
        wrapper:SetVisible(true)
        applyScroll(wrapper, hold.scroll)
    end)
    if not shown then holdDisabled, refreshQueued = true, true end
end

-- Called only by top-level onUpdate, never inside an observed native call.
-- CET shares a finite scratch arena across nested reflected calls. Walking
-- the UI from a native hook can exhaust it even if every getter is valid.
-- A new page is styled in batches (presentation.job); presentation.pending stays
-- set until the last batch, which also holds back the Back button and the status
-- line. A hover-out only re-tints that row's label (presentation.restyle), not the page.
-- Finds the new page's parts and hides its rows; returns the job, or nil when there is nothing to style.
local function beginStyleJob()
    if not presentation.active or not active() or not presentation.controller then
        presentation.pending = false
        return nil
    end
    local found = locateRoots(presentation.controller)
    presentation.roots = found
    presentation.statusWidget, presentation.renderRoot = found.status, found.render
    local content = found.content
    if not content then presentation.pending = false; return nil end
    veilPage(content)
    local job = {content = content, count = math.min(content:GetNumChildren(), 1200), index = 0,
        rows = {}, widgets = {}, at = 0}
    presentation.job = job
    return job
end

local function styleCompletedPage()
    if presentation.pending then
        local job = presentation.job
        if not job then
            job = beginStyleJob()
            if not job then return end
        end
        local budget = {left = STYLE_BUDGET}
        while job.index < job.count and budget.left > 0 do
            local widget = job.content:GetWidgetByIndex(job.index)
            local name = NameToString(widget:GetName())
            job.rows[#job.rows + 1] = {widget = widget, name = name}
            job.widgets[name] = widget
            job.index, budget.left = job.index + 1, budget.left - 1
        end
        if job.index < job.count then return end
        if job.at == 0 then
            presentation.voiceStatus = job.widgets[MOD_KEY .. ':voice-status_value']
            job.at = 1
        end
        while job.at <= #job.rows and budget.left > 0 do
            styleRow(job.rows[job.at], job.widgets, budget)
            job.at, budget.left = job.at + 1, budget.left - ROW_COST
        end
        if job.at <= #job.rows then return end
        presentation.pending, presentation.job = false, nil
    end
    if presentation.restyle and next(presentation.restyle) then
        local ids = presentation.restyle
        presentation.restyle = {}
        for id in pairs(ids) do
            local widget = presentation.tint[id]
            if widget and not presentation.hovered[id] then redLabel(widget) end
        end
    end
end
function M.styleStep() return styleCompletedPage() end
-- Right after this module drew a page itself (reloadMod), in the same frame: the rows are hidden before the frame is shown.
function M.styleBegin()
    if presentation.pending and not presentation.job then return beginStyleJob() end
end

-- Select options. The value of a select row sits between the game's two arrows in a fixed-width box, and a text that is too wide
-- runs over the arrows. The width is not ours to change (the game's settings widget), so every option is kept within OPTION_BUDGET.
-- optionUnits() is an estimate in "average lowercase letters": narrow letters (i l j t f r . , : ' space) count less, wide ones
-- (m w M W, capitals, digits) more, and a Chinese, Japanese or Korean character counts two.
-- The box holds about 32 of these units (OPTION_BOX_UNITS: the longest entry that is known to fit unfocused, OmniVoice · Ultra
-- Quality · needs Omni pack, is about 36, and the entries seen running over the arrows are about 33 to 41). On a focused row the game
-- also draws a key box over each arrow, an "A" at the left one and a "D" at the right one, and they cover the first and the last
-- letters of the text ("Gemma-4-E4B-MiniFo... (uncensored)" lost both ends). The selector is native, and neither the MCM scripts nor the
-- game scripts that ship with the mod carry its geometry, so the two boxes could not be measured: each is taken as 3 units
-- (KEY_HINT_UNITS). OPTION_BUDGET is what is left for the text between them, so a label fits focused as well as unfocused.
-- Static options are checked in bridge/select-labels.test.mjs; fitOption() is the last resort for a label built at run time (a
-- custom model's own name): it cuts the name, keeps a trailing " (...)" or " · ..." part and ends the name with an ellipsis.
-- Page build only, never per frame.
local OPTION_BOX_UNITS, KEY_HINT_UNITS = 32, 3
local OPTION_BUDGET = OPTION_BOX_UNITS - 2 * KEY_HINT_UNITS
local NARROW, MEDIUM = {}, {}
for letter in ("il.,:;'|!"):gmatch('.') do NARROW[letter] = true end
for letter in ('tfrI()-/[]'):gmatch('.') do MEDIUM[letter] = true end
local function optionUnits(text)
    local units, index, size = 0, 1, #text
    while index <= size do
        local byte = text:byte(index)
        local length = byte < 128 and 1 or byte >= 240 and 4 or byte >= 224 and 3 or byte >= 192 and 2 or 1
        local piece = text:sub(index, index + length - 1)
        if length == 1 then
            if piece == ' ' then units = units + 0.5
            elseif NARROW[piece] then units = units + 0.45
            elseif MEDIUM[piece] then units = units + 0.65
            elseif piece == 'm' or piece == 'w' then units = units + 1.45
            elseif piece == 'M' or piece == 'W' then units = units + 1.6
            elseif piece:find('[A-Z0-9]') then units = units + 1.15
            else units = units + 1 end
        elseif length == 2 then
            units = units + (piece == '·' and 0.65 or 1.05)
        elseif length == 3 then
            local code = (byte - 224) * 4096 + (piece:byte(2) - 128) * 64 + (piece:byte(3) - 128)
            if code >= 0x2E80 then units = units + 2
            elseif piece == '’' then units = units + 0.45
            else units = units + 1 end
        else
            units = units + 2
        end
        index = index + length
    end
    return math.floor(units * 10 + 0.5) / 10
end
-- Whole characters of `text` from the start while the part plus an ellipsis stays within `limit` units.
local function cutToUnits(text, limit)
    local cut, units, index, size = 0, optionUnits('…'), 1, #text
    while index <= size do
        local byte = text:byte(index)
        local length = byte < 128 and 1 or byte >= 240 and 4 or byte >= 224 and 3 or byte >= 192 and 2 or 1
        local after = units + optionUnits(text:sub(index, index + length - 1))
        if after > limit then break end
        units, cut, index = after, index + length - 1, index + length
    end
    return text:sub(1, cut) .. '…'
end
local function fitOption(text)
    text = tostring(text or '')
    if optionUnits(text) <= OPTION_BUDGET then return text end
    local at = text:find(' (', 1, true) or text:find(' ·', 1, true)
    if at and at > 1 then
        local head, tail = text:sub(1, at - 1), text:sub(at)
        local room = OPTION_BUDGET - optionUnits(tail)
        if room >= 8 then return cutToUnits(head, room) .. tail end
    end
    return cutToUnits(text, OPTION_BUDGET)
end
M.OPTION_BUDGET, M.OPTION_BOX_UNITS, M.KEY_HINT_UNITS, M.optionUnits, M.fitOption = OPTION_BUDGET, OPTION_BOX_UNITS, KEY_HINT_UNITS, optionUnits, fitOption

local function readonly(id, label, value, description, raw)
    raw = raw or {}
    return {id = id, label = raw.label and label or ui.t(label), value = raw.value and value or ui.t(value or ''),
        description = raw.description and description or ui.t(description or ''), type = 'string',
        capabilities = {read = true, write = false, draft = false, reset = false}}
end

local function setting(id, label, kind, value, default, description, elements, raw)
    raw = raw or {}
    local localized
    if elements then
        localized = {}
        for i, item in ipairs(elements) do localized[i] = fitOption(raw.elements and item or ui.t(item)) end
    end
    return {id = id, label = raw.label and label or ui.t(label), type = kind, value = value, defaultValue = default,
        description = raw.description and description or ui.t(description), elements = localized,
        capabilities = {read = true, write = true, draft = true, reset = true}}
end

local function action(id, label, value, description, callback, enabled, raw)
    actions[id] = callback
    raw = raw or {}
    if id:match('^invite:') or id:match('^dismiss:') or id:match('^memory:select:') then raw.label = true end
    if id == 'memory:choose' and value ~= 'Choose a character' then raw.value = true end
    if id == 'models:previous' or id == 'models:next' or id == 'memory:previous' or id == 'memory:next' then raw.description = true end
    local descriptionText = raw.description and description or ui.t(description)
    if id:match(':back$') or id == 'memory:settings' then
        currentBack = {id = id, label = raw.label and label or ui.t(label), callback = callback}
    end
    if (id:match(':back$') or id == 'memory:settings') and modelQuery ~= '' then
        -- MCM searches action descriptions too. Keep the sole parent link
        -- visible even for an empty result set, without changing its label.
        descriptionText = descriptionText .. '\n' .. modelQuery
    end
    return {id = id, label = raw.label and label or ui.t(label), value = raw.value and value or ui.t(value),
        description = descriptionText,
        type = 'action', disabled = enabled == false,
        capabilities = {read = true, action = enabled ~= false, write = false, draft = false, reset = false}}
end

local function category(id, name, settings, description)
    return {id = id, name = ui.t(name), description = ui.t(description or ''), settings = settings}
end

local function clearSearch(context)
    modelQuery, modelPage, searchFrames = '', 1, 0
    local controller = context and context.interaction and context.interaction.controller
    if controller then pcall(function() controller:McmUiEmitSearch('content', '') end) end
end

local function navigate(nextView, context)
    view = nextView
    clearSearch(context)
    return true
end

local function countKey(party, key)
    local count = 0
    for _, member in ipairs(party) do
        if member.key == key and member.state ~= 'leaving' then count = count + 1 end
    end
    return count
end

-- The saved settings that apply to every character, as the short lines the Characters sidebar shows under the
-- description. Built once per page build (the page rebuilds only when it opens or something changes), from the values
-- the snapshot already holds: no file is read and nothing runs per frame. Only what is switched on is named.
local function sharedCharacterLines(snapshot)
    local settings, speech, behavior = snapshot.settings, {}, {}
    if settings.naturalSpeech then speech[#speech + 1] = ui.t('Natural speech') end
    if settings.expressiveEmotions then speech[#speech + 1] = ui.t('Expressive emotions') end
    if settings.followUpInterest then speech[#speech + 1] = ui.t('Follow-up questions') end
    if settings.vVoice and settings.voiceProvider ~= 'convai' then speech[#speech + 1] = ui.t('V’s voice for typed lines') end
    local talk = {}
    if #speech > 0 then talk[#talk + 1] = ui.t('Speech: {list}', {list = table.concat(speech, ' · ')}) end
    if settings.multilingualConversations then talk[#talk + 1] = ui.t('Multilingual: replies in your language') end
    if settings.bodyGestures then behavior[#behavior + 1] = ui.t('Body gestures') end
    if settings.battleReactions then behavior[#behavior + 1] = ui.t('React to battles') end
    if settings.lootReactions then behavior[#behavior + 1] = ui.t('React to collected loot') end
    return {talk = talk,
        behavior = #behavior > 0 and ui.t('Behavior: {list}', {list = table.concat(behavior, ' · ')}) or nil,
        pack = manager.omniPack()}
end

-- The Characters sidebar text of one character: its description, then the settings in effect for it. `count` is the
-- number of copies in the party and `shared` comes from sharedCharacterLines.
local function profileDescription(profile, snapshot, shared, count)
    local settings = snapshot.settings
    local voice = profile.voiceName or ui.t('Convai voice')
    -- The label names the voice actually in use, which differs from the choice
    -- while a fallback is active.
    local active, routed = snapshot.localVoice.provider, false
    if active == 'pocket' or active == 'omni' then
        for _, key in ipairs(snapshot.localVoice.routedProfiles or {}) do
            if key == profile.key then
                voice = (snapshot.localVoice.cloudVoice == 'voxtral' or snapshot.localVoice.cloudVoice == 'inworld') and manager.voiceLabel(snapshot.localVoice.cloudVoice)
                    or manager.voiceLabel(active, snapshot.localVoice.omniSteps, snapshot.localVoice.omniReference)
                routed = true
                break
            end
        end
    end
    -- The Mistral cloud voice needs a Mistral key: say so instead of naming a voice that will not be heard.
    if not routed and settings.voiceProvider == 'voxtral' and not (snapshot.mistral or {}).saved then
        voice = ui.t('{voice} · needs Mistral key', {voice = manager.voiceLabel('voxtral')})
    end
    if not routed and settings.voiceProvider == 'inworld' and not ((snapshot.mistral or {}).inworld or {}).saved then
        voice = ui.t('{voice} · needs Inworld key', {voice = manager.voiceLabel('inworld')})
    end
    -- An OmniVoice choice cannot run without its pack: say so instead of naming a voice that will not be heard.
    if not routed and settings.voiceProvider == 'omni' and shared.pack.known and not shared.pack.installed then
        voice = ui.t('{voice} · needs Omni pack',
            {voice = manager.voiceLabel('omni', settings.omniSteps, settings.omniReference)})
    end
    local conversing = settings.enabledByKey[profile.key] ~= false
    local lines = {(profile.summary or profile.name) .. '\n', ui.t('Voice: {voice}',{voice=voice}),
        ui.t('Conversation: {state}',{state=ui.t(conversing and 'On' or 'Off')})}
    if conversing then
        local mode = settings.relationshipModes and settings.relationshipModes[profile.key]
        if mode then
            lines[#lines + 1] = ui.t('Relationship: {mode}', {mode = mode == 'on'
                and ui.t(profile.key == 'meredith-stout' and 'Casual' or 'Romantic')
                or ui.t(mode == 'off' and 'Ordinary' or 'Auto')})
        end
        for _, line in ipairs(shared.talk) do lines[#lines + 1] = line end
        local remembered = snapshot.memory and snapshot.memory.characters
        if remembered and remembered[profile.key] then lines[#lines + 1] = ui.t('Memory: remembers your conversations') end
    end
    if count > 0 then
        lines[#lines + 1] = ui.t('In your party: {count}', {count = count})
        if shared.behavior then lines[#lines + 1] = shared.behavior end
    end
    return table.concat(lines, '\n')
end

local function voiceServiceLabel(state)
    local labels = {ready = 'Ready', loading = 'Loading', warming = 'Preparing voices', speaking = 'Preparing a reply',
        error = 'Unavailable', waiting = 'Waiting for voice service', disabled = 'Not configured', stopped = 'Stopped',
        releasing = 'Releasing local voice memory', remote = 'Convai voices · Local model unloaded'}
    if state.pending then
        if state.preparationOnly then
            return ui.t('{status} · After current reply', {status=ui.t(labels[state.state] or 'Waiting for voice service')})
        end
        return ui.t('Changing after the current reply')
    end
    local fallback = state.fallback
    if type(fallback) == 'table' and (fallback.from == 'omni' or fallback.from == 'pocket' or fallback.from == 'voxtral' or fallback.from == 'inworld')
        and (fallback.to == 'pocket' or fallback.to == 'convai') then
        local values = {
            status = ui.t(labels[state.state] or 'Waiting for voice service'),
            voice = manager.voiceLabel(fallback.to, state.omniSteps, state.omniReference),
            requested = manager.voiceLabel(fallback.from, state.requestedOmniSteps, state.requestedOmniReference)}
        -- A temporary fallback is an Omni being loaded again in the background: it is coming back, not unavailable.
        if fallback.temporary == true then return ui.t('{status} · Using {voice}, {requested} not ready yet', values) end
        return ui.t('{status} · Using {voice}, {requested} unavailable', values)
    end
    if state.preparationOnly and state.previewActive
        and (state.previewProvider == 'pocket' or state.previewProvider == 'omni') and state.state == 'ready' then
        return ui.t('Ready · Unsaved selection')
    end
    local preview = voicePreview.inspect()
    if preview.active and (preview.provider == 'pocket' or preview.provider == 'omni') and state.state == 'remote' then
        return ui.t('Preparing voices')
    end
    return ui.t(labels[state.state] or 'Waiting for voice service')
end

-- The status line. While a different voice is pending in MCM's drafts it names
-- that voice instead (short, so the row is not truncated).
local function savedVoiceIndex(settings)
    return voicePreviewModule.indexOf(settings)
end

-- The select's labels, in menu order (fastest to best). The Inworld voice is the last entry and is listed only in developer mode.
-- An OmniVoice entry is greyed out while the optional pack is missing: voiceDisabled marks it, a step skips it, its value text is
-- dimmed, and applyBatch still refuses it (the bridge would fall back to Pocket TTS anyway). The menu is rebuilt with the page, so
-- the marks are too.
local function voiceMenuLabels(pack, mistral, developer)
    local elements = {}
    voiceDisabled = {}
    for index, choice in ipairs(VOICE_CHOICES) do
        -- Short (OPTION_BUDGET), so the entry does not run over the arrows or the key boxes of a focused row; the voice description says
        -- what the pack and the keys are. The two cloud voices have a menu name of their own: the full one ("Mistral cloud voice
        -- (Voxtral)") stays for sentences.
        if choice.provider ~= 'inworld' or developer then
            local label
            if choice.provider == 'voxtral' then
                label = (mistral or {}).saved and ui.t('Voxtral · Mistral cloud') or ui.t('Voxtral · needs Mistral key')
            elseif choice.provider == 'inworld' then
                label = ((mistral or {}).inworld or {}).saved and ui.t('Inworld · Cloud voice') or ui.t('Inworld · needs key')
            else
                label = manager.voiceLabel(choice.provider, choice.steps, choice.reference)
                if choice.provider == 'omni' and not pack.installed then voiceDisabled[#elements + 1] = true end
            end
            elements[#elements + 1] = label
        end
    end
    voiceMenuSize, voiceLabelsShown = #elements, elements
    return elements
end

local function voiceStatusText(snapshot, allowPending)
    if allowPending and api and type(api.getValue) == 'function' then
        -- Read from top-level update only, never while MCM is building a schema.
        local ok, value, err = pcall(api.getValue, MOD_KEY .. ':voiceProvider')
        local choice = ok and not err and VOICE_CHOICES[value]
        if choice and value ~= savedVoiceIndex(snapshot.settings) then
            return ui.t('Pending: {voice}', {voice = manager.voiceLabel(choice.provider, choice.steps, choice.reference)})
        end
    end
    return voiceServiceLabel(snapshot.localVoice)
end

local function updateVoiceStatus(snapshot)
    if view ~= 'settings' or not presentation.active or not presentation.voiceStatus then return end
    local text = voiceStatusText(snapshot, true)
    if text ~= presentation.voiceStatusText then
        -- Updating this read-only value preserves MCM's draft selectors. As
        -- with styling, ink access stays in top-level update, never its hooks.
        presentation.voiceStatus:SetText(text)
        presentation.voiceStatusText = text
    end
end

-- Mature content only works with the Local AI provider, its replies must not go to a cloud voice, and it never stands beside a cloud
-- provider (Convai free tier, Convai API key, Mistral). So turning it ON in the drafts also stages (as pending changes, before Apply)
-- the Local AI provider, the uncensored model and, when the companion voice is a cloud voice, Pocket TTS (a local voice is left as it
-- is); without the Local AI pack it cannot be on at all, and the switch is put back to off. Picking a cloud provider while it is on
-- turns it OFF in the drafts. Turning it OFF puts back what turning it on changed, unless the player changed it since. What was
-- changed is kept in matureMemory while the drafts are pending and, once applied, in the saved settings (manager: matureRestore). All of
-- it runs from M.update after a draft event, never in a hook, and costs nothing while no draft changes.
-- The provider drafts in menu order; PROVIDER_IDS names them for the restore record ('convai-key' is Convai with the player's own key).
local PROVIDER_IDS = {'convai', 'convai-key', 'mistral', 'local'}
local LOCAL_PROVIDER = 4
-- Why a model the player added cannot be used (bridge/custom-models.mjs reason codes), as a short phrase for the Local AI model row's help.
local function customProblemText(reason)
    if reason == 'missing' then return ui.t('file not found') end
    if reason == 'bad-gguf' then return ui.t('not a valid GGUF file') end
    if reason == 'embedding' then return ui.t('an embedding model, not a chat model') end
    return ui.t('could not be read')
end

local LOCAL_AI_PRESENT = {ready = true, warming = true, ['no-memory'] = true, failed = true}
local CLOUD_VOICES = {voxtral = true, inworld = true, convai = true}

local function draftValue(key)
    local ok, value, err = pcall(api.getValue, MOD_KEY .. ':' .. key)
    if ok and not err then return value end
end

local function stageDraft(key, index)
    local ok, done = pcall(api.setDraft, MOD_KEY .. ':' .. key, index)
    return ok and done == true
end

local function voiceRecord(index)
    local choice = VOICE_CHOICES[index]
    if not choice then return nil end
    return {provider = choice.provider, steps = choice.steps, reference = choice.reference}
end

local function voiceIndexOf(record)
    if type(record) ~= 'table' then return nil end
    return voicePreviewModule.indexOf({voiceProvider = record.provider, omniSteps = record.steps, omniReference = record.reference})
end

-- The position of a model in the row. 'auto' (an older version's Mature record) is the model shown as the default.
local function modelIndexOf(id)
    if id == 'auto' then id = manager.localModelDefaultId() end
    for index, choice in ipairs(manager.localModelChoices()) do if choice.id == id then return index end end
end

local function matureTurnedOn()
    local snapshot = manager.snapshot(player())
    local installed = LOCAL_AI_PRESENT[(snapshot.mistral or {}).localAi] == true
    local providerNow = draftValue('conversationProvider')
    local record, names = {}, {}
    local usingLocal = providerNow == LOCAL_PROVIDER
    if not usingLocal and not installed then
        -- Without the Local AI pack Mature content cannot be on beside a cloud provider: the switch goes back to off (the setting's
        -- help says Local AI is needed).
        matureMemory = nil
        stageDraft('matureContent', false)
        return nil
    end
    if not usingLocal and PROVIDER_IDS[providerNow] and stageDraft('conversationProvider', LOCAL_PROVIDER) then
        record.conversationProvider = {before = PROVIDER_IDS[providerNow], set = 'local'}
        names[#names + 1] = ui.t('Local AI')
        usingLocal = true
    end
    if usingLocal then
        -- The largest uncensored model that fits, when one is installed; otherwise the model is left alone.
        local choices = manager.localModelChoices()
        local modelNow = draftValue('localModel')
        local uncensoredId = manager.localModelMatureId()
        local target = uncensoredId and modelIndexOf(uncensoredId) or nil
        if target and type(modelNow) == 'number' and modelNow ~= target and choices[modelNow] and stageDraft('localModel', target) then
            record.localModel = {before = choices[modelNow].id, set = uncensoredId}
            names[#names + 1] = ui.t('Uncensored model')
        end
        local voiceNow = draftValue('voiceProvider')
        local choice = VOICE_CHOICES[voiceNow]
        if choice and CLOUD_VOICES[choice.provider] then
            -- A local voice (Pocket, OmniVoice) is left exactly as it is; only a cloud voice moves, and it moves to Pocket TTS.
            -- Multilingual conversations refuses Pocket TTS: then OmniVoice is the local voice to move to, and without its pack there is none.
            local multilingual = draftValue('multilingualConversations') == true
            local omni = manager.omniPack().installed == true
            if omni or not multilingual then
                local target = multilingual and 2 or 1
                if stageDraft('voiceProvider', target) then
                    record.voice = {before = voiceRecord(voiceNow), set = voiceRecord(target)}
                    local chosen = VOICE_CHOICES[target]
                    names[#names + 1] = manager.voiceLabel(chosen.provider, chosen.steps, chosen.reference)
                end
            end
        end
    end
    matureMemory = next(record) and record or nil
    if #names == 0 then return nil end
    return table.concat(names, ', ')
end

local function matureTurnedOff()
    local record = matureMemory
    if not record then record = manager.snapshot(player()).settings.matureRestore end
    matureMemory = nil
    if type(record) ~= 'table' then return nil end
    local names = {}
    local part = record.conversationProvider
    if part then
        local now, was = draftValue('conversationProvider'), nil
        for index, id in ipairs(PROVIDER_IDS) do if id == part.set then was = index end end
        local back
        for index, id in ipairs(PROVIDER_IDS) do if id == part.before then back = index end end
        if now == was and back and stageDraft('conversationProvider', back) then names[#names + 1] = ui.t('Conversation provider') end
    end
    part = record.localModel
    if part then
        local now, back = draftValue('localModel'), modelIndexOf(part.before)
        if now == modelIndexOf(part.set) and back and stageDraft('localModel', back) then names[#names + 1] = ui.t('Local AI model') end
    end
    part = record.voice
    if part then
        local now, back = draftValue('voiceProvider'), voiceIndexOf(part.before)
        if now == voiceIndexOf(part.set) and back and stageDraft('voiceProvider', back) then names[#names + 1] = ui.t('Companion voices') end
    end
    if #names == 0 then return nil end
    return table.concat(names, ', ')
end

-- The Conversation provider selector's index of the saved settings: 1 Convai free tier, 2 Convai API key, 3 Mistral, 4 Local.
local function providerIndexOf(settings)
    if settings.conversationProvider == 'local' then return 4 end
    if settings.conversationProvider == 'mistral' then return 3 end
    return settings.useOwnConvaiKey == true and 2 or 1
end

-- Looks at the Mature content and Conversation provider drafts after a draft event; acts only on a change of either: Mature content
-- turned on (the Local AI provider and what goes with it are staged), Mature content turned off (the way back), or a cloud provider
-- picked while it is on (it is turned off, with the same way back).
local function syncMature()
    -- All drafts are gone (Apply or Revert): what was staged is moot, and a check queued before that looked at old drafts.
    if matureReset then matureReset, matureCheck, matureSeen, matureMemory, providerSeen = false, false, nil, nil, nil end
    if not matureCheck then return end
    matureCheck = false
    local mature = draftValue('matureContent')
    if type(mature) ~= 'boolean' then return end
    local provider = draftValue('conversationProvider')
    local before, providerBefore = matureSeen, providerSeen
    if before == nil or providerBefore == nil then
        local saved = manager.snapshot(player()).settings
        if before == nil then before = saved.matureContent == true end
        if providerBefore == nil then providerBefore = providerIndexOf(saved) end
    end
    matureSeen, providerSeen = mature, provider
    if mature ~= before then
        if mature then matureChanges = matureTurnedOn() else matureChanges = matureTurnedOff() end
    elseif mature and type(provider) == 'number' and provider ~= providerBefore and provider ~= LOCAL_PROVIDER then
        if stageDraft('matureContent', false) then matureChanges = matureTurnedOff() end
    else
        return
    end
    -- What was just staged is not a change of the player's to look at again.
    local nowMature, nowProvider = draftValue('matureContent'), draftValue('conversationProvider')
    if type(nowMature) == 'boolean' then matureSeen = nowMature end
    if type(nowProvider) == 'number' then providerSeen = nowProvider end
end

local function samplePreparationFeedback()
    if not preparationTarget then preparationStatus = nil; return end
    local current = queue.preparationFeedback()
    if current and (preparationTarget == true or preparationTarget == current.id) then
        preparationTarget, preparationStatus = current.id, current
        if preparationActionFeedback then actionFeedback = current.message end
    else
        preparationTarget, preparationStatus = nil, nil
        if preparationActionFeedback then actionFeedback = nil end
        preparationActionFeedback = false
    end
end

local function updatePreparationBanner()
    if not presentation.active or not presentation.statusAllowed or not presentation.statusWidget then return end
    local current = preparationStatus
    local text, signature
    if current then text, signature = current.message, current.signature
    elseif presentation.preparationApplied then text, signature = actionFeedback or presentation.statusRestore or '', ''
    else return end
    if text ~= presentation.statusText or signature ~= presentation.preparationSignature then
        -- The installed renderer creates this inkText as "status". There is
        -- no MCM status setter: update only this owned widget from onUpdate.
        presentation.statusWidget:SetText(text)
        presentation.statusText, presentation.preparationSignature = text, signature
    end
    presentation.preparationApplied = current ~= nil
end

-- Add Back to the bottom action row from top-level update, after a render (a
-- new render clears the bar). The other buttons are found by their geometry (the
-- bar's 46-unit-high actions on the bottom line) and shifted left, so Back takes
-- the rightmost place and the row stays together. Every native call is guarded:
-- if Back cannot be added, the page gets a Back row instead.
local function placeBackButton()
    if backMode ~= 'bottom' or not currentBack or not presentation.active
        or presentation.backPlaced or not presentation.controller or presentation.pending then return end
    presentation.backPlaced = true
    local controller = presentation.controller
    local ok, err = pcall(function()
        local y, rightX = controller:McmUiGetLayoutMetric(27), controller:McmUiGetLayoutMetric(28)
        local contentX, contentInner = controller:McmUiGetLayoutMetric(20), controller:McmUiGetLayoutMetric(23)
        if type(y) ~= 'number' or y < 0 then error('layout metrics are unavailable') end
        if type(rightX) ~= 'number' or rightX <= 0 then rightX = (contentX or 0) + (contentInner or 0) end
        local render = presentation.renderRoot
        if not render then error('the render root is unavailable') end
        local bar, widest = {}, 0
        for index = 0, math.min(render:GetNumChildren(), 600) - 1 do
            local widget = render:GetWidgetByIndex(index)
            local margin = widget:GetMargin()
            if math.abs(margin.top - y) <= 2 and math.abs(widget:GetHeight() - 46) <= 2 then
                bar[#bar + 1] = widget
                widest = math.max(widest, widget:GetWidth())
            end
        end
        local width = widest > 0 and widest or math.max(120, (contentInner or 600) * 0.2)
        local shift = #bar > 0 and (width + BAR_GAP) or 0
        for _, widget in ipairs(bar) do
            local margin = widget:GetMargin()
            margin.left = margin.left - shift
            widget:SetMargin(margin)
        end
        controller:McmUiAddBottomActionAt(BACK_ID, ui.t('Back'), rightX - width, y, width, false)
        if not findWidget(render, 'mcm_action_' .. BACK_ID, 2) then error('the button was not created') end
        presentation.backBar = #bar
        log('Probe: Back placed x=' .. tostring(rightX - width) .. ' y=' .. tostring(y) .. ' width=' .. tostring(width)
            .. ' beside ' .. #bar .. ' button(s)')
    end)
    if not ok then
        backMode, refreshQueued = 'list', true
        log('Back could not be placed in the action row; using a row instead: ' .. tostring(err))
    end
end

-- Move MCM's status line from the bottom left to the top left, under the header
-- subtitle, while this page is open. A new render recreates the widget, so only a
-- widget that survives (a switch to another mod page) needs its place restored.
local function restoreStatusLine()
    if statusOriginal and not presentation.active then
        local original = statusOriginal
        statusOriginal = nil
        pcall(function()
            local margin = original.widget:GetMargin()
            margin.left, margin.top = original.left, original.top
            original.widget:SetMargin(margin)
            if original.parent then pcall(function() original.widget:Reparent(original.parent, -1) end) end
            if original.width then original.widget:SetWidth(original.width) end
            if original.height then original.widget:SetHeight(original.height) end
        end)
    end
end

local function placeStatusLine()
    if not presentation.active or not presentation.statusWidget or presentation.statusMoved
        or not presentation.controller or presentation.pending then return end
    presentation.statusMoved = true
    local ok, err = pcall(function()
        local render = presentation.renderRoot
        local list = presentation.roots and presentation.roots.sidebar
            or (render and findWidget(render, 'mcm_sidebar_scroll_content', 8))
        if not list then error('the mod list is unavailable') end
        local count = math.min(list:GetNumChildren(), 600)
        if count < 1 then error('the mod list is empty') end
        -- Below the last entry of the mod list, in the list's own column. The list
        -- keeps its place inside a clipped scroll area, so add the offsets of its
        -- containers up to the render root.
        local left, top, bottom, entryLeft = 0, 0, 0, nil
        -- The entries are laid out one under the other, so the first gives the column and the last the bottom: two entries
        -- are read, not the whole list (this can run inside MCM's own draw, where a list of 50 mods would be 150 native calls).
        for _, index in ipairs(count > 1 and {0, count - 1} or {0}) do
            local entry = list:GetWidgetByIndex(index)
            local margin = entry:GetMargin()
            entryLeft = entryLeft or margin.left
            bottom = math.max(bottom, margin.top + entry:GetHeight())
        end
        local status = presentation.statusWidget
        local width = list:GetWidth() - (entryLeft or 0)
        local inner = presentation.controller:McmUiGetLayoutMetric(13)
        if type(inner) == 'number' and inner > 0 then width = math.min(width, inner) end
        local margin = status:GetMargin()
        -- Keep the first recorded place: a widget that survives a render is already moved.
        statusOriginal = statusOriginal or {widget = status, left = margin.left, top = margin.top,
            width = status:GetWidth(), height = status:GetHeight(), parent = status:GetParentWidget()}
        -- Placing it inside the list itself needs no container offsets: its place is
        -- the list's own coordinates, just below the last entry.
        local mode = 'list'
        local moved = pcall(function() status:Reparent(list, -1) end)
        if moved then
            margin.left, margin.top = entryLeft or 0, bottom + 14
        else
            -- Fall back to render coordinates: add the offsets of the list's containers.
            mode = 'render'
            local left, top, node, depth = 0, 0, list, 0
            while node and node ~= render and depth < 10 do
                local nodeMargin = node:GetMargin()
                left, top = left + nodeMargin.left, top + nodeMargin.top
                local parent = node:GetParentWidget()
                if not parent then break end
                node, depth = parent, depth + 1
            end
            margin.left, margin.top = left + (entryLeft or 0), top + bottom + 14
        end
        status:SetMargin(margin)
        status:SetWidth(math.max(120, width))
        -- The label is centred vertically in its box, so a tall box pushes the text
        -- far below the entry. Anchor the text to the top and size the box to the
        -- wrapped text (line height scales with the live font size, not pixels).
        local okAlign = pcall(function() status:SetVerticalAlignment(textVerticalAlignment.Top) end)
        local sized, current = pcall(function() return status:GetFontSize() end)
        local fontSize = sized and tonumber(current) or 23
        local chars = #tostring(presentation.statusText or '')
        local lines = math.max(1, math.ceil(chars * fontSize * 0.55 / math.max(120, width)))
        status:SetHeight(math.ceil(lines * fontSize * 1.4) + 4)
        if not okAlign then log('Probe: status line could not be top-aligned') end
        -- Wrap inside the column and let the text grow downward.
        local wrapped = pcall(function() status:SetWrapping(true, math.max(120, width), textWrappingPolicy.Default) end)
        if not wrapped then pcall(function() status.wrapping, status.wrappingAtPosition = true, math.max(120, width) end) end
        log('Probe: status line moved (' .. mode .. ') to x=' .. tostring(margin.left) .. ' y=' .. tostring(margin.top)
            .. ' width=' .. tostring(width) .. ' (list bottom ' .. tostring(bottom) .. ', ' .. count .. ' entries)')
    end)
    if not ok then log('Status line could not be moved: ' .. tostring(err)) end
end

-- ---------------------------------------------------------------------------------------------------------------------------
-- Early style: the page is given its final look while MCM draws it.
--
-- Every value change makes MCM draw the whole page again, from its own update, after this module's update in the frame. Styling
-- it from this module's update therefore left the page in MCM's look for at least one frame (the first fix kept it hidden for
-- the one to three frames the styling took: a blank page, then the status line and the bottom buttons jumped into place).
-- So the final look is produced in the draw itself, with no widget work per row:
--  * a row's label, marker and read-only label are created with the geometry, size and colour the styling pass would give them
--    (the McmUiCreateText override changes only its arguments, inside the three row builders);
--  * the category headers are styled right after they are created (a few native calls each);
--  * the bottom action row is created once, with Back and the other buttons already in place (the buttons MCM adds on the
--    bar line are held back by the McmUiAddBottomActionAt override and created together, shifted, at the end of the draw);
--  * the status line is moved under the mod list at the end of the draw (about 15 native calls).
-- The page's content is still created hidden (contentHold). At the end of the draw it is shown if every step above
-- is known to have worked in this very draw (the hooks fired and agree with MCM's own counts, no step failed, the first label
-- has the expected margin, no font has to be applied); otherwise it stays hidden and the older styling pass (veilPage and
-- styleCompletedPage, which are idempotent over whatever this left) styles it and shows it, exactly as before. So a hook that is
-- missing or does nothing on some game version costs nothing but the old behaviour. Three failed draws in a row switch it off.
-- No per-frame cost: the overrides only act between McmUiBegin and McmUiSetContentTitle of the manager's own page.
-- ---------------------------------------------------------------------------------------------------------------------------
local RED_TOKEN = 'MainColors.Red'
local early = {on = false}
local earlyHooks, earlyOff, earlyFailures, earlyLogBudget = false, false, 0, 12
local earlyReleased, earlyHeld, earlyLastReason = 0, 0, ''
local pendingCategory
local fontsLibrary

local function earlyLog(text)
    if earlyLogBudget > 0 then earlyLogBudget = earlyLogBudget - 1; log('Probe: early style ' .. text) end
end

-- Whether this draw shows text in a script that needs a font of its own (a Cyrillic, Chinese, Japanese or Korean interface, or a
-- language chosen but not yet applied). Such a page is shown only after the font pass, so it keeps the older path.
local function fontsNeeded()
    local ok, needed = pcall(function()
        fontsLibrary = fontsLibrary or dofile('ui-fonts.lua')
        if fontsLibrary.family(ui.current()) then return true end
        if type(fontPresentation.applied) == 'function' and fontPresentation.applied() then return true end
        if view == 'settings' and api and type(api.getValue) == 'function' then
            local read, index, err = pcall(api.getValue, MOD_KEY .. ':uiLanguage')
            if not read or err then return true end
            local choice = ui.choices()[index]
            if not choice then return true end
            return fontsLibrary.family(choice.value == 'auto' and ui.current() or choice.value) ~= nil
        end
        return false
    end)
    return not ok or needed == true
end

local function earlyBegin(own)
    early = {on = own and earlyHooks and not earlyOff and not holdDisabled or false, at = os.clock(),
        tint = {}, kinds = {}, step = 0, started = 0, captured = 0, settingRows = 0}
    pendingCategory = nil
    if early.on then early.fonts = fontsNeeded() end
end

-- What a row's text is created with: x, width, font size and whether the colour is the red label colour. Step is the order of
-- the text inside the row builder (the managed row makes its marker first, then its label).
local function earlyRowText(kind, step, x, width)
    if kind == 'managed' then
        if step == 1 then return 0, 12, nil, false end
        if step == 2 then return 20, width + (x - 20), nil, true end
    elseif kind == 'action' then
        if step == 1 then return x, width, nil, true end
    elseif kind == 'readonly' then
        if step == 1 then return 0, width + x, CONTENT_FONT_SIZE, true end
    end
end

local function earlyCaptured(state, kind, step, widget, name)
    if not widget then return end
    if not kind then
        if NameToString(name) == 'status' then state.status = widget end
        return
    end
    local id = state.rowId
    if kind == 'managed' then
        if step == 2 then
            state.tint[id], state.kinds[id] = widget, 'managed'
            state.captured = state.captured + 1
            state.firstLabel = state.firstLabel or widget
        end
    elseif kind == 'action' then
        if step == 1 then state.tint[id], state.kinds[id] = widget, 'action' end
    elseif kind == 'readonly' then
        if step == 1 then state.tint[id], state.kinds[id] = widget, 'readonly'
        elseif step == 2 and id == MOD_KEY .. ':voice-status' then state.voiceStatus = widget end
    end
end

local function earlyCreateText(controller, parent, name, value, x, y, width, height, fontSize, color, alignment, wrapped)
    local state = early
    local kind = state.on and state.row or nil
    if not kind and not (state.on and state.phase == 'begin') then
        return wrapped(parent, name, value, x, y, width, height, fontSize, color, alignment)
    end
    local newX, newWidth, newSize, newColor, step = x, width, fontSize, color, nil
    if kind then
        state.step = state.step + 1
        step = state.step
        local ok, nx, nw, ns, red = pcall(earlyRowText, kind, step, x, width)
        if not ok then state.failed = state.failed or 'text'
        elseif nx ~= nil then
            newX, newWidth, newSize = nx, nw, ns or fontSize
            if red then
                local made, token = pcall(CName.new, RED_TOKEN)
                if made then newColor = token else state.failed = state.failed or 'colour' end
            end
        end
    end
    local widget = wrapped(parent, name, value, newX, y, newWidth, height, newSize, newColor, alignment)
    pcall(earlyCaptured, state, kind, step, widget, name)
    return widget
end

-- Runs one of MCM's row builders with the row's kind and id known to the text override.
local function earlyRow(kind, id, call)
    local state = early
    if not state.on then return call() end
    state.row, state.rowId, state.step = kind, id, 0
    if kind == 'managed' then state.started = state.started + 1 end
    local ok, err = pcall(call)
    state.row = nil
    if not ok then error(err, 0) end
end

local function earlyScrollArea(controller, parent, name, x, y, width, height, contentHeight, wrapped)
    local data = wrapped(parent, name, x, y, width, height, contentHeight)
    local state = early
    if state.on and data then
        pcall(function()
            if name == 'mcm_sidebar_scroll' then state.sidebar, state.render = data.content, parent
            elseif name == 'mcm_content_scroll' then state.content, state.wrapper = data.content, data.wrapper end
        end)
    end
    return data
end

local function earlyBottomAction(controller, id, label, x, y, width, active, wrapped)
    local state = early
    if state.on and not state.flushing and currentBack and backMode == 'bottom' and id ~= BACK_ID
        and type(state.barY) == 'number' and type(y) == 'number' and math.abs(y - state.barY) <= 2 then
        state.bar = state.bar or {}
        state.bar[#state.bar + 1] = {id = id, label = label, x = x, y = y, width = width, active = active}
        return
    end
    return wrapped(id, label, x, y, width, active)
end

-- Creates the buttons held back on the bar line, shifted to make room, and Back at the rightmost place (the geometry of
-- placeBackButton). Whatever happens every held button is created. Returns false and the problem if Back could not be placed.
local function earlyFlushBar(controller, state, withBack)
    if state.barDone then return true end
    state.barDone = true
    local bar, created = state.bar or {}, 0
    state.flushing = true
    local ok, err = pcall(function()
        local widest = 0
        for _, held in ipairs(bar) do widest = math.max(widest, tonumber(held.width) or 0) end
        local shift, backAt, backWidth = 0, nil, nil
        if withBack then
            local y, rightX = controller:McmUiGetLayoutMetric(27), controller:McmUiGetLayoutMetric(28)
            local contentX, contentInner = controller:McmUiGetLayoutMetric(20), controller:McmUiGetLayoutMetric(23)
            if type(y) ~= 'number' or y < 0 then error('layout metrics are unavailable') end
            if type(rightX) ~= 'number' or rightX <= 0 then rightX = (contentX or 0) + (contentInner or 0) end
            backWidth = widest > 0 and widest or math.max(120, (contentInner or 600) * 0.2)
            shift = #bar > 0 and (backWidth + BAR_GAP) or 0
            backAt = {y = y, x = rightX - backWidth}
        end
        for _, held in ipairs(bar) do
            controller:McmUiAddBottomActionAt(held.id, held.label, held.x - shift, held.y, held.width, held.active)
            created = created + 1
        end
        if backAt then
            controller:McmUiAddBottomActionAt(BACK_ID, ui.t('Back'), backAt.x, backAt.y, backWidth, false)
            state.backPlaced = true
        end
    end)
    if not ok then
        for index = created + 1, #bar do
            local held = bar[index]
            pcall(function() controller:McmUiAddBottomActionAt(held.id, held.label, held.x, held.y, held.width, held.active) end)
        end
    end
    state.flushing = false
    return ok, err
end

-- The end of the draw of the manager's own page (McmUiSetContentTitle). `presentation` is the new page's.
local function earlyFinish(controller, state, owned)
    local withBack = owned and currentBack ~= nil and backMode == 'bottom'
    local barOk, barError = earlyFlushBar(controller, state, withBack)
    if not barOk then
        backMode, refreshQueued = 'list', true
        log('Back could not be placed in the action row; using a row instead: ' .. tostring(barError))
    elseif state.backPlaced then
        presentation.backPlaced, presentation.backBar = true, #(state.bar or {})
    end
    local reason
    if not owned then
        reason = 'not the manager page'
    elseif not (state.status and state.wrapper and state.render and state.sidebar) then
        reason = 'widgets missing (status=' .. tostring(state.status ~= nil) .. ' wrapper=' .. tostring(state.wrapper ~= nil)
            .. ' list=' .. tostring(state.sidebar ~= nil) .. ')'
    else
        presentation.controller = controller
        presentation.statusWidget, presentation.renderRoot = state.status, state.render
        presentation.roots = {render = state.render, status = state.status, sidebar = state.sidebar, content = state.content}
        presentation.pending = false
        placeStatusLine()
        if state.failed then reason = 'a step failed: ' .. tostring(state.failed)
        elseif not contentHold then reason = 'content not held by this draw'
        elseif state.fonts then reason = 'fonts'
        elseif state.started ~= state.settingRows then reason = 'row hook count ' .. state.started .. '/' .. state.settingRows
        elseif state.started ~= state.captured then reason = 'labels ' .. state.captured .. '/' .. state.started
        elseif state.firstLabel then
            local read, margin = pcall(function() return state.firstLabel:GetMargin() end)
            if not read or not margin or margin.left ~= 20 then reason = 'label geometry' end
        end
        if not reason then
            if not pcall(function() state.wrapper:SetVisible(true) end) then reason = 'wrapper'
            else applyScroll(state.wrapper, contentHold and contentHold.scroll) end
        end
    end
    if reason then
        -- The older pass styles and shows the page (it was hidden by the hold, and stays so until then).
        if presentation.active then presentation.pending = true end
        earlyHeld = earlyHeld + 1
        earlyLastReason = reason
        if reason ~= 'fonts' and reason ~= 'not the manager page' then
            earlyFailures = earlyFailures + 1
            if earlyFailures >= 3 then earlyOff = true; log('Early page style switched off after three draws it could not complete: ' .. reason) end
        end
        earlyLog('held: ' .. reason)
        return
    end
    contentHold, earlyFailures, earlyReleased = nil, 0, earlyReleased + 1
    presentation.tint, presentation.rows, presentation.voiceStatus = state.tint, state.kinds, state.voiceStatus
    earlyLog('shown: rows=' .. tostring(state.started) .. ' categories=' .. tostring(state.categories or 0)
        .. ' bar=' .. tostring(#(state.bar or {})) .. ' back=' .. tostring(state.backPlaced == true))
end

-- A draw that never reached its end (an error in MCM's own code): the held buttons are created where MCM put them.
local function earlyStale()
    local state = early
    if not state.on or os.clock() - (state.at or 0) < 0.5 then return end
    early = {on = false}
    local controller = state.controller or presentation.controller
    if controller and state.bar and not state.barDone then pcall(earlyFlushBar, controller, state, false) end
end

local function installEarly()
    local complete = true
    local function hook(register, class, method, callback)
        local ok, err = pcall(register, class, method, callback)
        if not ok then complete = false; log('Early style hook not installed: ' .. method .. ' (' .. tostring(err) .. ')') end
    end
    local main = 'SettingsMainGameController'
    hook(Override, main, 'McmUiCreateText', earlyCreateText)
    hook(Override, main, 'McmUiCreateScrollArea', earlyScrollArea)
    hook(Override, main, 'McmUiAddBottomActionAt', earlyBottomAction)
    hook(Override, main, 'McmUiAddManagedLabel', function(controller, id, label, marker, modified, y, wrapped)
        return earlyRow('managed', id, function() return wrapped(id, label, marker, modified, y) end)
    end)
    hook(Override, main, 'McmUiAddActionSetting', function(controller, id, label, description, value, wrapped)
        return earlyRow('action', id, function() return wrapped(id, label, description, value) end)
    end)
    hook(Override, main, 'McmUiAddReadonly', function(controller, id, label, description, value, wrapped)
        return earlyRow('readonly', id, function() return wrapped(id, label, description, value) end)
    end)
    hook(ObserveAfter, 'SettingsCategoryController', 'McmUiSetup', function(controller)
        if early.on then pendingCategory = controller end
    end)
    hook(ObserveAfter, main, 'McmUiAddCategory', function()
        local state, category = early, pendingCategory
        pendingCategory = nil
        if not state.on or not category then return end
        local ok, err = pcall(function() styleCategory(category:GetRootWidget(), 0, 1, 6, {left = 400}) end)
        if ok then state.categories = (state.categories or 0) + 1 else state.failed = state.failed or 'category: ' .. tostring(err) end
    end)
    earlyHooks = complete
end

-- A voice that cannot be chosen (OmniVoice while its pack is missing) is greyed out: the value text of the Companion voices select is
-- dimmed while it shows one, and put back when it shows any other. A select shows one value at a time, so this is where a greyed-out
-- entry is seen at all (a saved choice can be one; a step never lands on one: see McmUiEmitStep in M.install). Runs from M.update
-- after the select refreshed, never in a hook; reads the few widgets of that one row.
local DIM_OPACITY = 0.4
local function dimVoiceValue(controller)
    local ok, value, err = pcall(api.getValue, MOD_KEY .. ':voiceProvider')
    local shown = ok and not err and type(value) == 'number' and voiceLabelsShown[value] or nil
    if not shown then return end
    local opacity = voiceDisabled[value] and DIM_OPACITY or 1.0
    local budget = {left = 60}
    local function visit(widget, depth)
        if not widget or depth < 0 or budget.left <= 0 then return end
        budget.left = budget.left - 1
        if widget:IsA('inkText') or widget:IsA('inkTextWidget') then
            if tostring(widget:GetText()) == shown then widget:SetOpacity(opacity) end
            return
        end
        local compound, count = pcall(function() return widget:GetNumChildren() end)
        if compound then
            for index = 0, math.min(count, 40) - 1 do visit(widget:GetWidgetByIndex(index), depth - 1) end
        end
    end
    visit(controller:GetRootWidget(), 6)
end

local function developerMode()
    if not manager or type(manager.developerMode) ~= 'function' then return false end
    local ok, enabled = pcall(manager.developerMode)
    return ok and enabled == true
end

-- Invitation progress and outcomes from the manager and the phone are merged
-- into one compact notice by the queue's notice board (mod/manager-party.lua).
local function invitationBoard()
    return queue and type(queue.board) == 'function' and queue.board() or nil
end

local function memorySettings(snapshot)
    local memory = snapshot.memory
    local pending = memory.command and memory.command.state == 'pending'
    local rows = {
        readonly('memory-identity', 'Player memory', 'Shared across your saves',
            'Invited characters are prepared immediately. Their memories start when you actually talk to them.\n\nOne player identity is shared across all saves and stays the same after forgetting.\n\nCurrent game context describes the world you have loaded.'),
        readonly('memory-service', 'Memory service', memory.state == 'ready' and 'Ready' or 'Unavailable',
            memory.state == 'ready' and 'Memories can be managed here.'
                or 'Reopen this page after the memory service reconnects. A pending clear keeps waiting for its own result.'),
        readonly('memory-count', 'Characters you have talked to',
            memory.talkedToCount and (memory.state == 'ready' and tostring(memory.talkedToCount)
                or ui.t('{count} · Last reported',{count=memory.talkedToCount})) or 'Unavailable',
            'Forget all memories applies to these characters.\n\nBrowsing the catalogue or inviting a companion does not add anyone to this count.'),
        action('memory:choose', 'Selected character', memory.selectedName or 'Choose a character',
            'Choose any character from the catalogue. They do not need to be in your current party.',
            function(context) return navigate('memory-characters', context) end, not pending and not memory.confirmation),
    }
    if memory.feedback ~= '' then rows[#rows + 1] = readonly('memory-feedback', 'Memory result', memory.feedback, memory.feedback) end
    local confirmation = memory.confirmation
    if confirmation then
        local description = confirmation.scope == 'all'
            and ui.t('Clear memories about you for all {count} characters you have talked to?',{count=confirmation.count})
            or ui.t('Clear {name}’s memories about conversations with you?',{name=confirmation.target})
        description = description .. ' ' .. ui.t('Your player identity stays the same. Matching Phone Chat messages and drafts are also cleared.')
        rows[#rows + 1] = readonly('memory-confirmation', 'Confirm memory clear', description, description)
        rows[#rows + 1] = action('memory:confirm:' .. confirmation.token, 'Confirm', 'Forget memories', description,
            function() return manager.confirmMemoryClear(confirmation.token) end,
            confirmation.scope == 'all' and memory.canClearAll or confirmation.scope == 'character' and memory.canClearCharacter)
        rows[#rows + 1] = action('memory:cancel:' .. confirmation.token, 'Cancel', 'Keep memories',
            'Cancel this request before anything is sent.', function() return manager.cancelMemoryClear(confirmation.token) end)
    else
        rows[#rows + 1] = action('memory:forget-character', 'Forget selected character', 'Forget',
            memory.selectedName and ui.t('Clear {name}’s memories about conversations with you. Review an inline confirmation first.',{name=memory.selectedName})
                or 'Choose a character before clearing their memories about you.',
            function() return manager.beginMemoryClear('character') end, memory.canClearCharacter)
        rows[#rows + 1] = action('memory:forget-all', 'Forget all memories',
            memory.talkedToCount and ui.t('Forget ({count} characters)',{count=memory.talkedToCount}) or 'Forget',
            'Clear memories about you for every character you have talked to.\n\nYour player identity stays. A confirmation comes first.',
            function() return manager.beginMemoryClear('all') end, memory.canClearAll)
    end
    rows[#rows + 1] = readonly('memory-chat-history', 'Phone Chat messages', 'Kept until forgotten',
        'Chat history stays available across game launches.\n\nForgetting a character also clears their saved Chat messages and drafts. Forgetting all memories clears all saved chats.')
    return rows
end

-- One API key as one row. Its action reads Paste while no key is saved and Remove once one is, and what a separate status row used to say
-- is in brackets after the name: the last four characters of a saved key (Added when the bridge sent none), or Checking… while it is
-- being checked. A paste that failed puts its message first in the row's help, and the row then says Not added. The names and the two
-- helps are source strings (the catalogue reads them from the call); `key` is {saved, tail, checking, message}. Only the last four
-- characters of a key are ever shown (docs/OWN_CONVAI_KEY.md): the key itself never reaches this file.
local function keyRow(name, pasteHelp, removeHelp, id, key, paste, remove, lastParagraph)
    local info
    if key.checking then info = ui.t('Checking…')
    elseif key.saved then info = key.tail and ('…' .. key.tail) or ui.t('Added')
    elseif key.message then info = ui.t('Not added') end
    local help
    if key.saved then
        help = ui.t(removeHelp) .. '\n\n' .. ui.t('Saved on this computer only. Only the last four characters are ever shown.')
    else
        help = ui.t(pasteHelp)
    end
    if key.message then help = key.message .. '\n\n' .. help end
    if lastParagraph then help = help .. '\n\n' .. lastParagraph end
    return action(id, ui.t(name) .. (info and (' (' .. info .. ')') or ''), key.saved and ui.t('Remove') or ui.t('Paste'), help,
        key.saved and remove or paste, nil, {label = true, value = true, description = true})
end

-- Settings > Conversation provider: the provider, Mature content, the Local AI model and the key rows of Convai and Mistral
-- (docs/OWN_CONVAI_KEY.md for the Convai key). The second result is the Inworld key row, which belongs to Settings > Development
-- (developer mode). The text shown here about a key is its status, never the key: only its last four characters, which the bridge
-- publishes, are ever displayed.
local function ownKeyRows(snapshot)
    local own, mistral = snapshot.ownKey, snapshot.mistral or {}
    local inworld = type(mistral.inworld) == 'table' and mistral.inworld or {}
    -- The message of a paste that did not work, for each key (the Convai key has two more reasons than the others).
    local ownMessage, result = nil, own.result
    if result == 'empty' then ownMessage = ui.t('The clipboard is empty. Copy your key first.')
    elseif result == 'not-a-key' then ownMessage = ui.t('The clipboard does not hold a Convai API key.')
    elseif result == 'invalid' then ownMessage = ui.t('Convai did not accept that key.')
    elseif result == 'clipboard' then ownMessage = ui.t('The clipboard could not be read.')
    elseif result == 'failed' then ownMessage = ui.t('The key could not be saved.') end
    local mistralMessage, mistralResult = nil, mistral.result
    if mistralResult == 'invalid' then mistralMessage = ui.t('Mistral did not accept that key.')
    elseif mistralResult == 'unreadable' then mistralMessage = ui.t('The clipboard could not be read.')
    elseif mistralResult == 'failed' then mistralMessage = ui.t('The key could not be saved.') end
    local inworldMessage, inworldResult = nil, inworld.result
    if inworldResult == 'invalid' then inworldMessage = ui.t('Inworld did not accept that key.')
    elseif inworldResult == 'unreadable' then inworldMessage = ui.t('The clipboard could not be read.')
    elseif inworldResult == 'failed' then inworldMessage = ui.t('The key could not be saved.') end
    -- Who answers right now, as the last paragraph of the provider row's help: only what the player has to act on or could not guess
    -- (a limit, a rejected key, a wait, a fallback, the free tier's allowance). The selected provider is the row's own value, and a
    -- key is never counted against the daily allowance (bridge/shared-key-guard.mjs).
    local note, limitHelp
    if mistral.pending then note = ui.t('Waiting for the conversation to end')
    elseif mistral.effective == 'mistral' then
        if mistral.limit == 'rate' or mistral.limit == 'daily' then note = ui.t('Mistral: free limit reached for now')
        elseif mistral.limit == 'invalid' then note = ui.t('Mistral: key not accepted')
        elseif mistral.limit == 'model' then note = ui.t('Mistral: model unavailable') end
    elseif mistral.effective == 'local' then note = nil
    elseif snapshot.settings.conversationProvider == 'local' then note = ui.t('Convai: Local AI is not ready')
    elseif snapshot.settings.conversationProvider == 'mistral' then note = ui.t('Convai: Mistral has no key yet')
    elseif own.limit == 'used-up' and own.limitOwn then note = ui.t('Your key: plan limit reached')
    elseif own.limit == 'used-up' then note = ui.t('Convai free tier: limit used up')
    elseif own.limit == 'rejected' then note = ui.t('Your key: not accepted')
    elseif own.limit == 'memory-needed' then note = ui.t('Your key: no room for memory')
    elseif own.active == 'player' and own.memoryOff then note = ui.t('Your own key, without memory')
    elseif own.active == 'player' then note = nil
    elseif own.daily and own.daily.blocked then
        -- The limit is reached: the status is the provider help's last paragraph (that help is already close to the panel's height in
        -- several languages) and what to do goes into the Mistral key row's help (the real limit comes from the sign-in backend,
        -- bridge/shared-key-guard.mjs).
        note = ui.t('Convai free tier: daily limit reached')
        limitHelp = ui.t('You have used today’s {limit} turns, which come back tomorrow. To keep talking now, choose Mistral (with your free key, about 5,000 turns a day) or Local AI (unlimited), then Apply.', {limit = own.daily.limit})
    elseif own.daily then note = ui.t('Convai free tier: {left} of {limit} left today', {left = own.daily.left, limit = own.daily.limit}) end
    -- The voice key needs speech recognition on this computer, which only the bridge can say it has.
    local providerHelp = mistral.stt
        and ui.t('Who writes your companions’ replies. A change waits until no conversation is running; choose Apply.\n\nConvai free tier needs no setup and gives better replies. Convai API key uses your own key, and Mistral its free plan with your own free key; memory stays on this computer.\n\nWith Mistral or Local, Convai’s cloud voice is replaced by a local voice. Speech is recognized on this computer, so the voice key works.')
        or ui.t('Who writes your companions’ replies. A change waits until no conversation is running; choose Apply.\n\nConvai free tier needs no setup and gives better replies. Convai API key uses your own key, and Mistral its free plan with your own free key; memory stays on this computer.\n\nWith Mistral or Local, Convai’s cloud voice is replaced by a local voice. Speech recognition for the voice key is not available yet with them, so type your messages.')
    if note then providerHelp = providerHelp .. '\n\n' .. note end
    -- Mature content is part of the main mod (off by default). It works with the Local AI provider only: turning it on selects Local AI,
    -- and choosing a cloud provider turns it off. The help says whether the optional Mature pack (uncensored models) is installed (the
    -- bridge reports its marker).
    local matureRow
    do
        local matureHelp = ui.t('Strong language, graphic violence, drugs and, between consenting adults, flirting and sex. Adults only (18+), Local AI only.')
        matureHelp = matureHelp .. '\n\n' .. (mistral.maturePack == true
            and ui.t('The Mature pack’s uncensored models give the full effect; standard models mostly refuse sex. Pack: installed.')
            or ui.t('The Mature pack’s uncensored models give the full effect; standard models mostly refuse sex. Pack: not installed (optional, on this mod’s GitHub page).'))
        matureHelp = matureHelp .. '\n\n' .. ui.t('Never allowed: sex with minors or without consent, sex about real people, hate, real-world weapon or drug instructions. A safety check enforces the minors rule.')
        matureHelp = matureHelp .. '\n\n' .. ui.t('Turning it on also selects Local AI, the largest uncensored model that fits and a local voice instead of a cloud one. Turning it off restores your choices.')
            .. ' ' .. ui.t('Choosing a cloud provider turns it off.')
        if not LOCAL_AI_PRESENT[mistral.localAi] then
            matureHelp = matureHelp .. '\n\n' .. ui.t('Needs the Local AI pack.')
        end
        matureRow = setting('matureContent', 'Mature content', 'bool', snapshot.settings.matureContent, false, matureHelp, nil, {description = true})
    end
    -- Which installed Local AI model loads: each installed model by its manifest name, smallest file first (the bridge reports the list); the sizes
    -- are in the help. No Auto entry: while nothing was chosen the model the bridge would load is shown as selected. The state of the Local AI
    -- pack is not a row of its own: while it warms up, or cannot start or run, the row's name says so in brackets and the help starts with the
    -- sentence the loading notices use; ready and not installed need no words (the model list says No model installed).
    local modelRow
    do
        local choices, labels, selected, sizes, anyCustom = manager.localModelChoices(), {}, 1, {}, false
        local found = false
        for index, choice in ipairs(choices) do
            labels[index] = choice.name
            if choice.id == snapshot.settings.localModel then selected, found = index, true end
            do
                local gb = string.format('%.1f', choice.sizeMiB / 1024)
                if choice.custom then
                    -- A model the player added by hand: marked "(custom)", with the graphics memory it needs or that the card is too small for it.
                    anyCustom = true
                    if choice.tooLarge then
                        labels[index] = ui.t('{name} (custom · too large)', {name = choice.name})
                        sizes[#sizes + 1] = ui.t('{name} (custom, {size} GB, too large for this card)', {name = choice.name, size = gb})
                    else
                        labels[index] = ui.t('{name} (custom)', {name = choice.name})
                        sizes[#sizes + 1] = choice.sizeMiB > 0
                            and ui.t('{name} (custom, {size} GB, needs {need} GB)', {name = choice.name, size = gb, need = string.format('%.1f', choice.needMiB / 1024)})
                            or ui.t('{name} (custom)', {name = choice.name})
                    end
                else
                    sizes[#sizes + 1] = choice.sizeMiB > 0 and string.format('%s (%.1f GB)', choice.name, choice.sizeMiB / 1024) or choice.name
                end
            end
        end
        -- Nothing chosen yet (a saved 'auto'), or a saved model that is gone: the model the bridge loads instead is the one shown as selected.
        if not found then
            local default = manager.localModelDefaultId()
            for index, choice in ipairs(choices) do if choice.id == default then selected = index end end
        end
        if #choices == 0 then labels[1] = ui.t('No model installed') end
        local modelHelp = ui.t('Until you choose one, Local AI loads the largest model that fits your free graphics memory.\n\nOne model at a time; a change applies when it next loads. A model that is missing, too large or failing is replaced by the largest that fits, with one notice.')
        if #sizes > 0 then modelHelp = modelHelp .. '\n\n' .. table.concat(sizes, '\n') end
        if anyCustom then
            modelHelp = modelHelp .. '\n\n' .. ui.t('Custom models are ones you added; they join the default choice by size.')
        end
        local problems = {}
        for _, problem in ipairs(manager.localModelProblems()) do
            problems[#problems + 1] = ui.t('{name}: {reason}', {name = problem.name, reason = customProblemText(problem.reason)})
        end
        if #problems > 0 then modelHelp = modelHelp .. '\n\n' .. ui.t('Not usable: {models}. See the Local AI notes, "Add your own model".', {models = table.concat(problems, '; ')}) end
        local state, status = mistral.localAi, nil
        local label = ui.t('Local AI model')
        if state == 'warming' then label, status = label .. ' (' .. ui.t('Warming up') .. ')', loadingText('local-ai', 'loading')
        elseif state == 'no-memory' then label, status = label .. ' (' .. ui.t('Not enough memory') .. ')', loadingText('local-ai', 'no-memory')
        elseif state == 'failed' then label, status = label .. ' (' .. ui.t('Unavailable') .. ')', loadingText('local-ai', 'failed') end
        if status then modelHelp = status .. '\n\n' .. modelHelp end
        modelRow = setting('localModel', label, 'select', selected, 1, modelHelp, labels, {elements = true, description = true, label = true})
    end
    local rows = {
        setting('conversationProvider', 'Conversation provider', 'select', providerIndexOf(snapshot.settings), 1, providerHelp,
            {'Convai free tier', 'Convai API key', 'Mistral (free plan)', 'Local (needs Local AI pack)'}, {elements = true, description = true}),
        -- Companions can see (docs/COMPANION_VISION.md): Convai only, on by default; the bridge does all the work.
        setting('companionVision', 'Companions can see', 'bool', snapshot.settings.companionVision ~= false, true,
            'With each line, the character also gets a recent picture of your surroundings, taken from the game window a few seconds before you started talking.\n\nOnly the game window is captured, only while someone you can talk to is near, and pictures are kept in memory for a short time, never saved. Works with Convai only.'),
        matureRow,
        modelRow,
        keyRow('Convai API key',
            'Copy your key first. It is read from the clipboard once, checked with Convai and saved on this computer.',
            'Deletes the saved key. Conversations go back to Convai free tier.',
            'own-key', {saved = own.saved, tail = own.tail, checking = result == 'checking', message = ownMessage},
            function() return manager.pasteOwnKey() end, function() return manager.removeOwnKey() end),
        keyRow('Mistral API key',
            'Copy your free key from Mistral first (signing up there needs phone verification). It is read from the clipboard once, checked with Mistral and saved on this computer.\n\nYou can also save it in player-mistral-key.txt in the conversation service folder. Mistral allows about one message a second and about 5,000 turns a day. It sets its own monthly cap, estimated at about 150,000 turns.',
            'Deletes the saved key. Conversations go back to Convai free tier.',
            'mistral-key', {saved = mistral.saved == true, tail = mistral.tail, message = mistralMessage},
            function() return manager.pasteMistralKey() end, function() return manager.removeMistralKey() end, limitHelp),
    }
    -- Convai paid tier: right under the Convai API key row, whose key a plan is bought for.
    if paidTier then
        table.insert(rows, 6, action('paid-tier', 'Convai paid tier', 'Open',
            'Convai’s plans for this mod: more Convai conversations on your own Convai API key. Opens a page with the plans and their prices.',
            function(context)
                paidTier.request('refresh')
                return navigate('paid-tier', context)
            end))
    end
    if editor then
        rows[#rows + 1] = action('character-editor:open', 'Edit characters', 'Open',
            'Edit a character’s bio, speaking style, speaking rules and memories in your browser.\n\nWorks with Mistral and Local, not Convai. Changes apply from the next reply.',
            function() return editor.request() end)
    end
    -- The Inworld key belongs to the Inworld cloud voice, which is a developer-mode voice: its row sits in Settings > Development.
    local inworldRow = keyRow('Inworld API key',
        'Copy your key from Inworld first. It is read from the clipboard once, checked with Inworld and saved on this computer.\n\nYou can also save it in player-inworld-key.txt in the conversation service folder. It is used only for the Inworld voice.',
        'Deletes the saved key. The Inworld cloud voice stops until you add a key again.',
        'inworld-key', {saved = inworld.saved == true, tail = inworld.tail, message = inworldMessage},
        function() return manager.pasteInworldKey() end, function() return manager.removeInworldKey() end)
    return rows, inworldRow
end

-- Settings > Conversation provider > Convai paid tier (docs/CONVAI_PAID_TIER.md): the player's plan, the Convai API key row (a plan is
-- bought for that key), one row per plan, a check and the Convai billing page. Prices and plans come from the conversation service
-- (bridge/convai-paid-tier.mjs), which also does every request; this page only sends commands through mod/convai-paid-tier.lua.
local function paidTierRows(snapshot)
    local state, own = paidTier.state(), snapshot.ownKey
    local keySaved = own.saved == true
    local rows = {action('paid-tier:back', 'Back to settings', 'Back', 'Return to conversation settings.',
        function(context) return navigate('settings', context) end)}
    if not state.available then
        rows[#rows + 1] = readonly('paid-unavailable', 'Convai paid tier', 'Unavailable',
            'The conversation service is not running, so plans cannot be shown. Restart the game.')
        return {category('paid-tier', 'Convai paid tier', rows)}
    end
    local planValue, planHelp
    if not keySaved then planValue, planHelp = ui.t('No key added'), ui.t('Add your Convai API key below to see and buy a plan.')
    elseif state.plan and state.plan.name then
        planValue = state.plan.name
        planHelp = state.plan.paid and ui.t('Conversations with Convai API key chosen as the provider use this plan.')
            or ui.t('This key has no paid plan. Choose a plan below.')
    else planValue, planHelp = ui.t('Not checked yet'), ui.t('Choose Check my plan to ask Convai.') end
    local message = paidTier.message(state)
    if message then planHelp = message .. '\n\n' .. planHelp end
    rows[#rows + 1] = readonly('paid-plan', 'Your Convai plan', planValue, planHelp, {value = true, description = true})
    if not keySaved then
        -- Sign in with Convai (bridge/convai-signin.mjs): Convai's login page hands the key back to the conversation service.
        rows[#rows + 1] = action('paid:sign-in', 'Sign in with Convai', 'Sign in',
            'Opens Convai’s sign-in page in your browser.\n\nSign in or make a free account, and your Convai API key is saved on this computer, the same as Paste. You have five minutes.',
            function() return paidTier.request('sign-in') end)
        rows[#rows + 1] = action('paid:key-page', 'Get your Convai API key', 'Open',
            'Opens convai.com in your browser. Sign in or make a free account, copy your API key, then come back and choose Paste below.',
            function() return paidTier.request('key-page') end)
    end
    local ownMessage = own.result == 'empty' and ui.t('The clipboard is empty. Copy your key first.')
        or own.result == 'not-a-key' and ui.t('The clipboard does not hold a Convai API key.')
        or own.result == 'invalid' and ui.t('Convai did not accept that key.')
        or own.result == 'clipboard' and ui.t('The clipboard could not be read.')
        or own.result == 'failed' and ui.t('The key could not be saved.') or nil
    rows[#rows + 1] = keyRow('Convai API key',
        'Copy your key first. It is read from the clipboard once, checked with Convai and saved on this computer.',
        'Deletes the saved key. Conversations go back to Convai free tier.',
        'paid-own-key', {saved = keySaved, tail = own.tail, checking = own.result == 'checking', message = ownMessage},
        function() return manager.pasteOwnKey() end, function() return manager.removeOwnKey() end)
    local plans = {}
    for _, plan in ipairs(state.plans) do
        local label = plan.period == 'yearly' and ui.t('{plan}, {price} a year', {plan = plan.name, price = plan.price})
            or ui.t('{plan}, {price} a month', {plan = plan.name, price = plan.price})
        -- What the plan gives that this mod uses: its monthly interactions. (Its concurrent connections are not named: on a player's own key
        -- the mod keeps one conversation connection at a time, docs/OWN_CONVAI_KEY.md.)
        local gives = plan.interactions and ui.t('{count} Convai interactions a month.', {count = plan.interactions})
            or ui.t('More Convai interactions a month than Gamer.')
        local billed = plan.period == 'yearly' and ui.t('Billed once a year.') or ui.t('Billed every month.')
        local help = gives .. ' ' .. billed .. '\n\n'
            .. ui.t('Opens Convai’s payment page (Stripe) in your browser. You pay Convai directly; the mod never sees your card. Your plan is active about 15 seconds after you pay, and conversations then use your Convai API key.')
        if not keySaved then help = ui.t('Add your Convai API key first.') .. '\n\n' .. help end
        local id = plan.id
        plans[#plans + 1] = action('paid:buy:' .. id, label, 'Buy', help, function()
            if not keySaved then return false, 'Add your Convai API key first.' end
            return paidTier.request('buy', id)
        end, keySaved, {label = true, description = true})
    end
    plans[#plans + 1] = action('paid:check', 'Check my plan', 'Check',
        'Asks Convai which plan your key has now. After paying, it can take about 15 seconds.',
        function()
            if not keySaved then return false, 'Add your Convai API key first.' end
            return paidTier.request('check')
        end, keySaved)
    plans[#plans + 1] = action('paid:manage', 'Manage or cancel plan', 'Open',
        'Opens your Convai billing page in your browser. Sign in with the same Convai account to change or cancel your plan.',
        function() return paidTier.request('manage') end)
    return {category('paid-tier', 'Convai paid tier', rows,
            'Plans Convai made for this mod. They give your own Convai API key more conversations; the free tier stays as it is.'),
        category('paid-plans', 'Plans', plans, 'Prices in US dollars. You can cancel at any time on Convai’s billing page.')}
end

-- What the current page shows that can change without the player touching it, as one string: the page is drawn again only
-- when this changes, so a state the page does not show (a voice going from loading to ready while the Characters list is
-- open, the voice status line that is rewritten in place) never redraws it. Every field below is read by that page's rows.
local function pageSignature(snapshot)
    local parts = {view}
    local function add(text) parts[#parts + 1] = text end
    local function memorySignature()
        local memory = snapshot.memory
        add(table.concat({memory.state, tostring(memory.talkedToCount), memory.feedback,
            memory.selectedKey or '', memory.confirmation and memory.confirmation.token or '',
            memory.command and memory.command.id or '', memory.command and memory.command.scope or '',
            memory.command and memory.command.profileKey or '', memory.command and memory.command.state or ''}, '|'))
    end
    if view == 'characters' or view == 'party' then
        add(tostring(queue.message()))
        add(tostring(queue.count()))
        for _, member in ipairs(queue.list()) do
            add(table.concat({member.id, member.state or '', member.profileKey or '', member.error or '', member.dismissError or ''}, '|'))
        end
    end
    if view == 'party' then
        local trip = queue.chauffeur()
        add(table.concat({trip.phase or '', tostring(trip.stopPending), trip.reason or '', trip.error or ''}, '|'))
    end
    if view == 'characters' or view == 'memory' or view == 'memory-characters' then memorySignature() end
    if view == 'characters' then
        local voice, pack = snapshot.localVoice, manager.omniPack()
        add(table.concat({voice.provider or '', tostring(voice.cloudVoice), tostring(voice.omniSteps), tostring(voice.omniReference),
            table.concat(voice.routedProfiles or {}, ','), tostring(pack.known), tostring(pack.installed),
            tostring((snapshot.mistral or {}).saved), tostring(((snapshot.mistral or {}).inworld or {}).saved)}, '|'))
    end
    if view == 'models' then
        add(tostring(#snapshot.models))
        add(tostring(snapshot.scan.finished))
    end
    if support and view == 'help' then add('help:' .. support.signature() .. '|' .. support.serviceState()) end
    if paidTier and view == 'paid-tier' then
        local own = snapshot.ownKey
        add(table.concat({'paid', tostring(own.saved), own.tail or '', own.result or '', paidTier.signature()}, '|'))
    end
    if view == 'settings' then
        -- The key rows change when the bridge answers a Paste or Remove, or reports a used-up plan; the provider rows when its
        -- state changes (Local AI warming up and ready); the voice list when the OmniVoice pack appears. The voice status line
        -- is not here: it is updated in place.
        local own, pack, mistral = snapshot.ownKey, manager.omniPack(), snapshot.mistral or {}
        local inworld = type(mistral.inworld) == 'table' and mistral.inworld or {}
        add(table.concat({'key', tostring(own.saved), own.tail or '', own.active, tostring(own.pending),
            own.result or '', own.limit or '', tostring(own.limitOwn), tostring(own.memoryOff),
            own.daily and (tostring(own.daily.left) .. '/' .. tostring(own.daily.blocked)) or ''}, '|'))
        add(table.concat({'provider', tostring(mistral.saved), mistral.tail or '', mistral.provider or '', mistral.effective or '',
            mistral.localAi or '', tostring(mistral.maturePack), tostring(mistral.pending), mistral.result or '', mistral.limit or '', tostring(mistral.stt),
            tostring(inworld.saved), inworld.tail or '', inworld.result or '',
            tostring(pack.known), tostring(pack.installed), tostring(snapshot.settings.developerMode)}, '|'))
        -- The Local AI model row lists what is installed.
        local modelKey = {'models'}
        modelKey[#modelKey + 1] = 'd:' .. tostring(mistral.localModelDefault) .. ':' .. tostring(mistral.localModelMatureDefault)
        for _, model in ipairs(mistral.localModels or {}) do
            modelKey[#modelKey + 1] = model.id .. ':' .. model.name .. ':' .. tostring(model.sizeMiB) .. ':' .. tostring(model.custom) .. ':' .. tostring(model.tooLarge) .. ':' .. tostring(model.needMiB)
        end
        for _, problem in ipairs(mistral.localModelProblems or {}) do modelKey[#modelKey + 1] = 'x:' .. problem.name .. ':' .. problem.reason end
        add(table.concat(modelKey, '|'))
        -- Installed add-ons' own settings (docs/ADDON_API.md); nothing without one.
        if convaiAddons and convaiAddons.live then add('addons:' .. convaiAddons.signature()) end
    end
    return table.concat(parts, '\n')
end

local function schema()
    local currentPlayer = player()
    owner = identity(currentPlayer)
    queue.bind(owner)
    local snapshot, party = manager.snapshot(currentPlayer), queue.list()
    renderedSignature = pageSignature(snapshot)
    lastSignature = renderedSignature
    actions = {}
    currentBack = nil
    local categories = {}
    local rows = {}
    -- The party has a fixed number of formation places. It is not shown: a full
    -- party answers an invitation with a message from the queue.
    local canInvite = owner ~= nil
    if view == 'home' then
        for _, tab in ipairs({{'characters', 'Characters to invite'}, {'party', 'Current party'},
            {'models', 'Model browser'}, {'settings', 'Settings'}}) do
            -- The Model browser lists every character model in the game, so it says that and what joining means.
            local description = tab[1] == 'models'
                and ui.t('Browse every character model in the game and invite any of them, including characters without conversation support. They join as followers and do not talk.')
                or ui.t('Browse {section}. {query}',{section=ui.t(tab[2]):lower(),query=modelQuery})
            rows[#rows + 1] = action('tab:' .. tab[1], tab[2], 'Open', description,
                function(context) return navigate(tab[1], context) end)
        end
        -- The page title already says Companion Manager: the section header is blank (a
        -- single space; an empty name would fall back to the category id).
        categories[#categories + 1] = category('navigation', ' ', rows)
    elseif view == 'characters' then
        local shared = sharedCharacterLines(snapshot)
        for _, profile in ipairs(snapshot.profiles) do
            local key = profile.key
            local count = countKey(party, key)
            local available = manager.definition(key) ~= nil
            rows[#rows + 1] = action('invite:' .. key, profile.name,
                available and (count > 0 and ui.t('Add copy ({count})',{count=count}) or 'Invite') or 'Profile only',
                profileDescription(profile, snapshot, shared, count), function() return queue.invite(key) end, canInvite and available)
        end
        categories[#categories + 1] = category('characters', 'Characters to invite', rows,
            'Search a character by name. Each invitation reserves a place and starts preparation immediately.')
    elseif view == 'party' then
        local trip = queue.chauffeur()
        local status = {}
        if trip.active then
            local tripStates = {releasing = 'Preparing to drive', ['boarding-driver'] = 'Driver boarding',
                ['waiting-for-player'] = 'Waiting for you to board', ['waiting-for-party'] = 'Waiting for party to board',
                starting = 'Starting trip', driving = 'Driving',
                stopping = 'Stopping', ['waiting-for-player-exit'] = 'Waiting for you to step out',
                ['exiting-driver'] = 'Driver leaving the car'}
            status[#status + 1] = readonly('chauffeur-state', 'Companion driver',
                trip.stopPending and 'Stop requested' or tripStates[trip.phase] or trip.phase,
                'Ask a companion to drive to your selected map waypoint.\n\nGet into the passenger seat when they are ready.')
            status[#status + 1] = action('chauffeur:stop', 'Companion driver', 'Stop trip',
                'Stop the trip after returning to gameplay. Wait for the car to stop, then step out before dismissing the driver.',
                function() return queue.stopTrip() end, not trip.stopPending)
        end
        if #status > 0 then categories[#categories + 1] = category('party-status', 'Your group', status) end
        -- One row per copy: its name and number, with Dismiss on the right. A copy
        -- dismissed while the world is paused is dropped from the list at once;
        -- the queue deletes it after gameplay resumes and lists it again with the
        -- reason if the game refuses.
        local shown = 0
        for _, member in ipairs(party) do
            if member.state ~= 'leaving' then
                shown = shown + 1
                local id = member.id
                local display = member.serial and ((member.baseName or member.name) .. ' #' .. member.serial)
                    or ui.t('{name} · invited copy', {name = member.name})
                local problem = member.dismissError or (member.state == 'failed' and member.error) or nil
                rows[#rows + 1] = action('dismiss:' .. id, display,
                    member.serial and 'Dismiss' or 'Cancel invitation',
                    ui.t('Remove only this copy from your group.') .. (problem and ('\n' .. ui.t(problem)) or ''),
                    function() return queue.dismiss(id) end, nil, {description = true})
                if problem then
                    local text = (member.baseName or member.name) .. ': ' .. ui.t(problem)
                    rows[#rows + 1] = readonly('error:' .. id, text, '', text, {label = true, description = true})
                end
            end
        end
        if shown == 0 then rows[#rows + 1] = readonly('empty-party', 'Your party is empty', '', 'Invite someone from Characters or Model browser.') end
        categories[#categories + 1] = category('party', 'Current party', rows)
    elseif view == 'models' then
        local matches = {}
        local query = modelQuery:lower()
        for _, model in ipairs(snapshot.models) do
            if query == '' or model.search:find(query, 1, true) then matches[#matches + 1] = model end
        end
        local pages = math.max(1, math.ceil(#matches / MODEL_PAGE_SIZE))
        modelPage = math.max(1, math.min(modelPage, pages))
        local scan = snapshot.scan
        local talking = 0
        for _, model in ipairs(matches) do if model.profileName then talking = talking + 1 end end
        rows[#rows + 1] = readonly('model-status', scan.finished and ui.t('{count} matching models',{count=#matches}) or 'Reading installed models…',
            ui.t('Page {page} / {pages}',{page=modelPage,pages=pages}),
            ui.t('Search by character name or model record using Search settings. {query}',{query=modelQuery})
                .. '\n' .. ui.t('{count} of them can talk.', {count = talking})
                .. '\n' .. (ui.t(scan.error) or ''))
        if modelPage > 1 then
            rows[#rows + 1] = action('models:previous', 'Previous models', 'Previous', modelQuery,
                function() modelPage = math.max(1, modelPage - 1); return true end)
        end
        if modelPage < pages then
            rows[#rows + 1] = action('models:next', 'More models', 'Next', modelQuery,
                function() modelPage = modelPage + 1; return true end)
        end
        for index = (modelPage - 1) * MODEL_PAGE_SIZE + 1, math.min(modelPage * MODEL_PAGE_SIZE, #matches) do
            local model = matches[index]
            local key = model.key
            local modelName = model.unnamedIndex and ui.t('Unnamed model {index}',{index=model.unnamedIndex}) or model.name
            local conversation = model.archetype and ui.t('Conversation: {name} (archetype)', {name = model.profileName})
                or model.profileName and ui.t('Conversation: {state}',{state=model.profileName})
                or ui.t('No conversation profile. This model joins as a follower without AI conversations.')
            rows[#rows + 1] = action('invite:' .. key, modelName, 'Invite',
                model.record .. '\n\n' .. conversation
                    .. '\n' .. ui.t('Some game models have special rigs or roles and may not behave as ordinary companions.'),
                function() return queue.invite(key) end, canInvite)
        end
        categories[#categories + 1] = category('models', 'Installed character models', rows,
            'Every character model found in the game, including characters without conversation support. Those join as followers and do not talk.')
    elseif view == 'memory' then
        rows = memorySettings(snapshot)
        table.insert(rows, 1, action('memory:settings', 'Back to settings', 'Back',
            'Return to conversation settings.', function(context) return navigate('settings', context) end))
        categories[#categories + 1] = category('memory', 'Memory', rows,
            'Characters build memories through your conversations and keep them across saves.')
    elseif view == 'memory-characters' then
        local matches = {}
        local query = modelQuery:lower()
        for _, profile in ipairs(snapshot.profiles) do
            if query == '' or (profile.name .. ' ' .. profile.key .. ' ' .. table.concat(profile.aliases or {}, ' ')):lower():find(query, 1, true) then
                matches[#matches + 1] = profile
            end
        end
        local pages = math.max(1, math.ceil(#matches / MODEL_PAGE_SIZE))
        modelPage = math.max(1, math.min(modelPage, pages))
        rows[#rows + 1] = action('memory:back', 'Back to memory', 'Back',
            'Return to the memory controls.', function(context)
                navigate('memory', context)
                return manager.closeMemoryPicker()
            end)
        rows[#rows + 1] = readonly('memory-character-page', 'Choose a character', ui.t('Page {page} / {pages}',{page=modelPage,pages=pages}),
            ui.t('Search by character name using Search settings. {query}\nThe character can be outside your current party.',{query=modelQuery}))
        if modelPage > 1 then
            rows[#rows + 1] = action('memory:previous', 'Previous characters', 'Previous', modelQuery,
                function() modelPage = modelPage - 1; return true end)
        end
        if modelPage < pages then
            rows[#rows + 1] = action('memory:next', 'More characters', 'Next', modelQuery,
                function() modelPage = modelPage + 1; return true end)
        end
        for index = (modelPage - 1) * MODEL_PAGE_SIZE + 1, math.min(modelPage * MODEL_PAGE_SIZE, #matches) do
            local profile = matches[index]
            local key = profile.key
            rows[#rows + 1] = action('memory:select:' .. key, profile.name,
                snapshot.memory.selectedKey == key and 'Selected' or 'Choose',
                ui.t('Select {name} for memory controls. This does not invite them or change their conversation settings.',{name=profile.name}),
                function(context)
                    local ok, reason = manager.selectMemoryCharacter(key)
                    if ok then navigate('memory', context) end
                    return ok, reason
                end)
        end
        categories[#categories + 1] = category('memory-characters', 'Whose memories', rows)
    elseif view == 'relationships' then
        rows[#rows + 1] = action('relationships:back', 'Back to settings', 'Back',
            'Return to conversation settings.', function(context) return navigate('settings', context) end)
        for _, profile in ipairs(manager.relationshipChoices()) do
            local mode = snapshot.settings.relationshipModes[profile.key]
            -- The saved values stay auto / on / off; only the labels read Romantic (Casual for Meredith) / Ordinary.
            local casual = profile.key == 'meredith-stout'
            local description = casual
                and 'Auto: follows the completed encounter in this save.\n\nCasual: speaks with that familiarity.\n\nOrdinary: keeps her usual manner.\n\nIt does not imply an ongoing relationship.'
                or 'Auto: follows the relationship in this save.\n\nRomantic: speaks to V as a partner.\n\nOrdinary: keeps their usual manner.\n\nOnly changes how they talk, never your game choices.'
            rows[#rows + 1] = setting('relationship:' .. profile.key, profile.name, 'select',
                mode == 'on' and 2 or mode == 'off' and 3 or 1, 1, description,
                {'Auto', casual and 'Casual' or 'Romantic', 'Ordinary'})
        end
        categories[#categories + 1] = category('relationships', 'Relationships', rows,
            'Judy, Panam, River, Kerry and Meredith can speak as a partner or in their ordinary manner.\n\nAuto follows the relationship in your save.')
    elseif view == 'help' and support then
        local where, report = support.locations(), support.status()
        local files = {mod = 'probe.log, mcm.log', bridge = 'bridge.stderr.log', launcher = 'launcher.log',
            cet = 'cyber_engine_tweaks.log', redscript = 'redscript_rCURRENT.log', red4ext = 'red4ext-*.log',
            reports = 'convai-report-*.zip'}
        local rawRow = {value = true, description = true}
        local copyDescription = report.path
            and ui.t('Copy the report path to the clipboard so you can paste it into a message.')
            or ui.t('Create a report first, then copy its path.')
        local lastValue, lastDescription = ui.t('None yet'), ui.t('Choose Generate report. The file name and its folder appear here and in the banner above.')
        if report.path then
            lastValue = report.fileName
            lastDescription = ui.t('Saved at {path}', {path = support.displayPath(report.path)})
            if report.mode == 'lua' then
                lastDescription = lastDescription .. '\n' .. ui.t('This is a short report: the conversation service was not available to build the full one.')
            end
        end
        rows[#rows + 1] = action('help:back', 'Back to settings', 'Back', 'Return to conversation settings.',
            function(context) return navigate('settings', context) end)
        rows[#rows + 1] = readonly('help-steps', 'What to do', 'Create a report',
            'If a character stops answering, voices stop or an error appears: choose Generate report and send the file it names to the developer, with a short note about what you were doing.\n\nThe logs listed below show what went wrong.')
        rows[#rows + 1] = readonly('help-service', 'Conversation service', support.serviceLabel(),
            'The conversation service runs beside the game. If it is not running, restart the game. Its logs are listed below.', {value = true})
        categories[#categories + 1] = category('help-trouble', 'If something goes wrong', rows)
        categories[#categories + 1] = category('help-report', 'Report for the developer', {
            action('help:generate', 'Generate report', 'Create',
                'Saves a report file you can send to the developer.\n\nAPI keys, tokens, IDs, microphone audio and conversation text are left out. Without the conversation service, a shorter report is made from the files the game can read.',
                function() return support.request() end, report.phase ~= 'working'),
            readonly('help-last', 'Last report', lastValue, lastDescription, {value = report.path ~= nil, description = true}),
            action('help:copy', 'Copy report path', 'Copy',
                copyDescription,
                function() return support.copyPath() end),
        }, 'One file with versions, settings and the latest log lines. It never contains your API key, tokens, voice recordings or conversation text.')
        categories[#categories + 1] = category('help-logs', 'Where the logs are', {
            readonly('help-log-mod', 'Mod logs', files.mod,
                ui.t('Mod logs such as probe.log and mcm.log are in {path}', {path = where.mod}), rawRow),
            readonly('help-log-bridge', 'Conversation service logs', files.bridge,
                ui.t('The conversation service writes bridge.stderr.log, bridge.stdout.log and bridge-service.log in {path}', {path = where.bridge}), rawRow),
            readonly('help-log-launcher', 'Launcher log', files.launcher,
                ui.t('The service launcher writes launcher.log at {path}', {path = where.launcher}), rawRow),
            readonly('help-log-cet', 'Cyber Engine Tweaks logs', files.cet,
                ui.t('Cyber Engine Tweaks writes cyber_engine_tweaks.log and scripting.log in {path}', {path = where.cet}), rawRow),
            readonly('help-log-redscript', 'Redscript log', files.redscript,
                ui.t('The redscript compiler writes redscript_rCURRENT.log at {path}', {path = where.redscript}), rawRow),
            readonly('help-log-red4ext', 'RED4ext logs', files.red4ext,
                ui.t('RED4ext writes its logs in {path}', {path = where.red4ext}), rawRow),
            readonly('help-log-reports', 'Saved reports', files.reports,
                ui.t('Generated reports are saved in {path}. The five newest are kept.', {path = where.reports}), rawRow),
        }, 'Send the generated report rather than raw log files. Open these locations only if the developer asks for a specific file.')
    elseif view == 'paid-tier' and paidTier then
        for _, section in ipairs(paidTierRows(snapshot)) do categories[#categories + 1] = section end
    elseif view == 'settings' then
        -- The Inworld cloud voice is a developer-mode voice (Settings > Development): its name appears in the help of a setting only
        -- while developer mode is on, as one more paragraph after the help that holds for everybody.
        local developer = snapshot.settings.developerMode == true
        local function withInworld(row, extra)
            if developer then row.description = row.description .. '\n\n' .. ui.t(extra) end
            return row
        end
        local choices, languageElements, languageIndex = ui.choices(), {}, 1
        for index, choice in ipairs(choices) do
            languageElements[index] = choice.label
            if choice.value == snapshot.settings.uiLanguage then languageIndex = index end
        end
        categories[#categories + 1] = category('interface', 'Interface', {
            setting('uiLanguage', 'Interface language', 'select', languageIndex, 1,
                'Changes this mod’s menus and notices only.\n\nCharacter voices and the language you talk in are separate.',
                languageElements, {elements=true}),
        })
        categories[#categories + 1] = category('conversation-controls', 'Conversations', {
            action('memory', 'Memory', 'Manage',
                'See what each character remembers and make one or all of them forget.\n\nMemories are kept across saves.',
                function(context) return navigate('memory', context) end),
            action('relationships', 'Relationships', 'Manage',
                'Judy, Panam, River, Kerry and Meredith can speak as a partner or in their ordinary manner.\n\nAuto follows the relationship in your save.',
                function(context) return navigate('relationships', context) end),
            setting('archetypeConversations', 'Talk to ordinary NPCs', 'bool', snapshot.settings.archetypeConversations ~= false, true,
                'Gang members, NCPD officers, guards, ripperdocs, shopkeepers, bartenders and passers-by answer as their kind of person.\n\nThey do not know your story and forget you after a save load, except shopkeepers you come back to.\n\nNamed characters are not affected.'),
            withInworld(setting('multilingualConversations', 'Multilingual conversations', 'bool', snapshot.settings.multilingualConversations, false,
                'Talk in any language; each character answers in yours.\n\nA separate multilingual copy of each character is used, so what they remember from these talks stays apart from your English ones. Forgetting a character clears both.\n\nPocket and Voxtral speak English only, so this switches the voice to OmniVoice · Balanced, or to Convai · Cloud voice without the OmniVoice pack. Without the pack, Natural speech and Expressive emotions turn off.'),
                'Inworld speaks English only as well.'),
            setting('autoConnectNearby', 'Auto-connect nearby characters', 'bool', snapshot.settings.autoConnectNearby, true,
                'Gets a conversation ready when you look at, approach or have just talked to a character, so they answer without a wait. Paused in combat and scenes.\n\nLimits: two characters ready at once, a new one every 3 s, released after 40 s unused. A crowd never adds up.'),
            setting('gameDialogueContext', 'Continue from game dialogue', 'bool', snapshot.settings.gameDialogueContext, true,
                'Right after the game’s own dialogue with a character, they know its last few lines, including your chosen replies and your phone calls with them.\n\nOnly the last few minutes count, and none of it is saved to memory.'),
            -- Holocalls start from the mod's Chat tab (docs/HOLOCALL.md); this is their only setting.
            setting('holocallLiveImage', 'Live holocall picture', 'bool', snapshot.settings.holocallLiveImage == true, true,
                'Shows the character live in a holocall instead of their portrait.\n\nExperimental: the picture can stay empty. If she cannot be shown, the call goes on with the portrait.'),
        })
        -- Settings > Conversation provider: who writes the replies, Mature content, Local AI and the provider keys (the Inworld key is in
        -- Development).
        local providerRows, inworldKeyRow = ownKeyRows(snapshot)
        categories[#categories + 1] = category('conversation-provider', 'Conversation provider', providerRows)

        local heights,strengths=manager.gazeChoices()
        local heightIndex,strengthIndex=3,3
        for index,value in ipairs(heights) do if snapshot.settings.eyeContactHeight==value then heightIndex=index end end
        for index,value in ipairs(strengths) do if snapshot.settings.headFollowStrength==value then strengthIndex=index end end
        categories[#categories + 1] = category('companion-behavior', 'Companion behavior', {
            setting('eyeContactHeight', 'Eye contact height', 'select', heightIndex, 3,
                'Use it if companions seem to look above or below your eyes.',
                {'10 cm lower', '5 cm lower', 'Default', '5 cm higher', '10 cm higher'}),
            setting('headFollowStrength', 'Head tracking strength', 'select', strengthIndex, 3,
                'Eyes only: the head stays still and just the eyes move.\n\nSubtle to Strong: the head turns toward you more and more.',
                {'Eyes only', 'Subtle', 'Gentle (default)', 'Strong'}),
            setting('bodyGestures', 'Body gestures', 'bool', snapshot.settings.bodyGestures, true,
                'Companions gesture while they speak longer replies and nod while you talk, with the game’s own animations in their usual stance.\n\nThey stop at once when anyone moves or a fight starts.'),
        })
        local voiceStatus = voiceStatusText(snapshot)
        -- The list: Pocket Performance (the default), OmniVoice Balanced / Quality (16 steps, short / long reference),
        -- High Quality / Ultra Quality (32 steps, short / long reference), the Mistral cloud voice (Voxtral), Convai Cloud voice.
        local voiceIndex = savedVoiceIndex(snapshot.settings)
        -- Lip sync delay (Bluetooth): Auto, Off, then milliseconds (bridge/audio-delay.mjs).
        local delays, delayLabels, delayIndex = manager.audioDelayChoices(), {}, 1
        for index, value in ipairs(delays) do
            delayLabels[index] = value == 'auto' and ui.t('Auto') or value == 0 and ui.t('Off') or (tostring(value) .. ' ms')
            if snapshot.settings.audioDelay == value then delayIndex = index end
        end
        local pack = manager.omniPack()
        -- While the OmniVoice pack is missing its entries are greyed out; the row's name says why, in brackets.
        local voiceName = ui.t('Companion voices')
        if pack.known and not pack.installed then voiceName = voiceName .. ' (' .. ui.t('no Omni pack') .. ')' end
        local voicesCategory = category('voices', 'Voices', {
            setting('voice', 'Voice playback', 'bool', snapshot.settings.voice, true, 'Off: replies are text only and no voice is generated.\n\nWith Subtitles off as well, automatic reactions stay silent.'),
            withInworld(setting('voiceProvider', voiceName, 'select', voiceIndex, 1,
                'Pocket: the lightest, runs on your CPU, starts speaking in about 0.2 s.\n\nOmniVoice: richer, especially on harder voices. Needs a capable GPU and the OmniVoice pack (greyed out until it is installed); the higher tiers start in 1 to 2.5 s.\n\nVoxtral: each companion’s own voice from the cloud, with your own Mistral key, English only. It loads no local voice model.\n\nConvai: its own cloud voice. A voice that cannot run is replaced by a simpler one, with one notice.',
                voiceMenuLabels(pack, snapshot.mistral, developer), {elements = true, label = true}),
                'Inworld: the same with your own Inworld key, and it also speaks with emotion.'),
            readonly('voice-status', 'Voice status', voiceStatus,
                'Changes wait until you choose Apply; Revert discards them. No game restart is needed.'),
            setting('audioDelay', 'Lip sync delay (Bluetooth)', 'select', delayIndex, 1,
                'Bluetooth audio arrives a little late, so lips and subtitles can run ahead of the voice. This holds them back to match, for every voice.\n\nAuto: 150 ms while Windows plays through Bluetooth, none otherwise. Pick a value if your headset is faster or slower.\n\nThe game’s own dialogue has the same delay and does not correct it.',
                delayLabels, {elements = true}),
            withInworld(setting('naturalSpeech', 'Natural speech', 'bool', snapshot.settings.naturalSpeech, false,
                'Companions now and then pause, hesitate, laugh or sigh, as their personality would. Each character decides when; it stays rare.\n\nOmniVoice can voice laughs and sighs; the other voices only add pauses.\n\nNot available with Convai’s cloud voice: choosing it turns this off, and turning this on switches the voice to Pocket.'),
                'Inworld can voice laughs and sighs too.'),
            withInworld(setting('expressiveEmotions', 'Expressive emotions', 'bool', snapshot.settings.expressiveEmotions, true,
                'Each character marks its own feelings as it speaks, so the face changes at that word instead of being guessed from the text. Subtle, set by personality, only where a feeling really shifts.\n\nNot available with Convai’s cloud voice: choosing it turns this off, and turning this on switches the voice to Pocket.'),
                'Inworld always speaks with emotion, whatever this says.'),
            setting('followUpInterest', 'Follow-up questions', 'bool', snapshot.settings.followUpInterest, true,
                'Characters sometimes ask about something you said, pick up something from earlier or share a thought that invites an answer.\n\nNow and then, never on every reply, and never while you are leaving, giving an order or fighting.'),
            setting('vVoice', 'V’s voice for typed lines', 'bool', snapshot.settings.vVoice, true,
                ui.t('When you type a line, V says it out loud too, in the male or female V voice that matches yours. Push-to-talk is never replayed.\n\nV speaks first, then the companion answers. A slow V line is skipped, so the reply is never delayed.\n\nUses the voice chosen above, cloned for V.')
                    .. (snapshot.settings.voiceProvider == 'convai' and ('\n\n' .. (developer
                        and ui.t('Works with the Pocket, OmniVoice, Voxtral or Inworld voices.')
                        or ui.t('Works with the Pocket, OmniVoice or Voxtral voices.'))) or ''),
                nil, {description = true}),
        }, 'Changes wait until you choose Apply.')
        categories[#categories + 1] = voicesCategory
        categories[#categories + 1] = category('subtitles', 'Subtitles', {
            setting('subtitles', 'Subtitles', 'bool', snapshot.settings.subtitles, true, 'Shows companion replies as text.\n\nWith Voice playback off as well, automatic reactions stay silent.'),
            setting('subtitleStyle', 'Subtitle display', 'select', snapshot.settings.subtitleStyle == 'overhead' and 2 or 1, 1,
                'Cinematic: the game’s regular dialogue subtitles.\n\nAbove the speaker: over the companion who is talking.\n\nThe Subtitles switch turns both off.',
                {'Cinematic subtitles', 'Above the speaker'}),
        })
        categories[#categories + 1] = category('reactions', 'Automatic reactions', {
            setting('battleReactions', 'React to battles', 'bool', snapshot.settings.battleReactions, false,
                'A nearby companion makes one short comment as combat starts and another afterward.\n\nTen-minute cooldown after a fight. Conversations and story scenes come first. Loading a save resets the cooldown.'),
            setting('lootReactions', 'React to collected loot', 'bool', snapshot.settings.lootReactions, false,
                'Companions comment after you finish collecting loot from the world. Storage transfers stay silent.\n\nOrdinary comments are ten minutes apart; newly acquired Legendary gear has its own two-minute cooldown.\n\nPickups made during a fight are folded into one comment at its end.'),
        })
        -- One section per installed add-on that has settings (docs/ADDON_API.md). The add-on wrote its own labels.
        if convaiAddons and convaiAddons.live then
            local own = {label = true, description = true, elements = true}
            for _, section in ipairs(convaiAddons.settingsSections()) do
                local list = {}
                for _, item in ipairs(section.items) do
                    list[#list + 1] = setting(item.mcmId, item.label, item.kind, item.value, item.default, item.description,
                        item.elements, own)
                end
                categories[#categories + 1] = {id = section.id, name = section.title, description = section.description, settings = list}
            end
        end
        -- Developer mode lists the Inworld cloud voice (in Voices) and puts its key here.
        local development = {
            setting('developerMode', 'Developer mode', 'bool', snapshot.settings.developerMode, false,
                'For testing and bug reports; leave it off for normal play.\n\nShows routine popups (joining steps, dismissals, driving instructions, results of companion actions), writes a movement trace in the mod’s runtime folder, logs gesture decisions and adds itself to support reports.\n\nPreparation progress, joined notices, failures and replies to Stop trip stay visible when it is off.'),
        }
        if developer then development[#development + 1] = inworldKeyRow end
        categories[#categories + 1] = category('development', 'Development', development)
        if support then
            categories[#categories + 1] = category('help', 'Help', {
                action('help', 'Help and support', 'Open',
                    'Find the log files and create a report to send to the developer if something goes wrong.',
                    function(context) return navigate('help', context) end),
            })
        end
    end
    if view == 'characters' or view == 'party' or view == 'models' or view == 'settings' then
        table.insert(categories[1].settings, 1, action(view .. ':back', 'Back to Companion Manager', 'Back',
            'Return to Companion Manager.', function(context) return navigate('home', context) end))
    end
    -- Back leaves the list: it is the bottom-bar button (its callback stays
    -- registered). In row mode it is the last row of the page, never the first.
    if currentBack then
        local moved
        for index = #categories, 1, -1 do
            local list = categories[index].settings
            for position = #list, 1, -1 do
                if list[position].id == currentBack.id then moved = table.remove(list, position) end
            end
        end
        for index = #categories, 1, -1 do
            if #categories[index].settings == 0 then table.remove(categories, index) end
        end
        if moved and backMode ~= 'bottom' then
            if #categories == 0 then categories[1] = category('navigation-back', 'Companion Manager', {}) end
            table.insert(categories[#categories].settings, moved)
        end
    end
    return {name = ui.t(LABEL), description = ui.t('Your companions, character models and conversation settings.'), categories = categories}
end

function M.configure(domain, companions, queueFactory, entryFactory, readiness)
    manager, queue = domain, queueFactory.new(companions, readiness, {developerMode = domain.developerMode})
    -- Any change to the queue is flushed by the next frame, not by the next slow tick.
    for _, method in ipairs({'invite', 'dismiss', 'dismissCharacter', 'undoDismiss', 'assign', 'gameVoice', 'stopTrip'}) do
        local original = queue[method]
        if type(original) == 'function' then
            queue[method] = function(...) flushDue = true; return original(...) end
        end
    end
    -- Developer-mode probe rows (runtime/perf-probe.json): where the settings integration spends its time.
    pcall(function()
        local probe = convaiPerfProbe
        if type(probe) ~= 'table' or type(probe.watch) ~= 'function' then return end
        probe.watch(queue, 'flush', 'mcm.queue.flush')
        probe.watch(M, 'slowUpdate', 'mcm.slow')
        probe.watch(M, 'styleStep', 'mcm.style')
        probe.watch(M, 'activeCheck', 'mcm.active')
        probe.watch(fontPresentation, 'update', 'mcm.fonts')
    end)
    entry = entryFactory.new(function() return ui.t(LABEL) end, function() return api ~= nil end, log, active)
    if supportLoaded and type(supportFactory) == 'table' and type(supportFactory.new) == 'function' then
        local created, instance = pcall(supportFactory.new, {ui = ui, party = function() return queue.list() end,
            developerMode = function() return developerMode() end})
        if created and type(instance) == 'table' then support = instance end
    end
    if editorLoaded and type(editorFactory) == 'table' and type(editorFactory.new) == 'function' then
        local created, instance = pcall(editorFactory.new, {ui = ui,
            serviceState = function() return support and support.serviceState() or 'unknown' end})
        if created and type(instance) == 'table' then editor = instance end
    end
    if paidTierLoaded and type(paidTierFactory) == 'table' and type(paidTierFactory.new) == 'function' then
        local created, instance = pcall(paidTierFactory.new, {ui = ui})
        if created and type(instance) == 'table' then paidTier = instance end
    end
    provider = {
        id = PROVIDER, registrationKey = 'cyberpunk-convai.manager.v1', apiVersion = 2,
        name = 'Cyberpunk Convai', shortName = 'CONVAI',
        capabilities = {index = true, lazy = true, draft = true, action = true, atomicApply = true, dynamicSchema = true},
        listMods = function()
            return {complete = true, revision = tostring(ui.revision()), mods = {{id = MOD, name = ui.t(LABEL),
                description = ui.t('Invite characters, manage your group, browse game models and configure conversations.')}}}
        end,
        closeMod = function(id)
            if id == MOD then
                local ok, pending = pcall(function() return api and api.hasDrafts(MOD_KEY) end)
                if ok and pending == true then log('Probe: closeMod with unapplied changes (MCM discards them)') end
            end
            return true
        end,
        loadMod = function(id)
            if id ~= MOD then return nil, ui.t('Unknown mod.') end
            entry.selected()
            return schema()
        end,
        invokeAction = function(id, actionId, context)
            if id ~= MOD or not actions[actionId] then return {ok = false, error = ui.t('Reopen the manager; that action is no longer available.')} end
            local ok, reason, invitationId = actions[actionId](context)
            actionFeedback = ok == true and ui.t(reason) or nil
            preparationActionFeedback = false
            if actionId:match('^invite:') and type(invitationId) == 'string' then
                local board = invitationBoard()
                if board then board.track(invitationId, 'manager') end
            end
            if ok == true and actionId:match('^invite:') then
                preparationTarget = true
                preparationStatus, preparationAt, preparationActionFeedback = nil, 0, true
            elseif ok ~= true or reason ~= nil then
                -- Navigation has no result message and leaves progress visible.
                -- A memory, dismissal or trip action owns its own result banner.
                preparationTarget, preparationStatus = nil, nil
            end
            memoryActionCommand = nil
            if ok == true and actionId:match('^memory:confirm:') then
                local command = manager.snapshot(player()).memory.command
                memoryActionCommand = command and command.id or nil
            end
            return {ok = ok == true, error = ok ~= true and ui.t(reason) or nil, schemaChanged = ok == true}
        end,
        applyBatch = function(id, changes)
            if id ~= MOD then return {ok = false, error = ui.t('Unknown mod.')} end
            -- Auto Apply sets a draft and applies in the same instant. Refuse that
            -- call so the draft stays pending; nothing is saved or sent anywhere.
            if os.clock() - lastDraftEventAt < AUTO_APPLY_WINDOW then
                return {ok = false, error = hintPending()}
            end
            local values, applied = {relationshipModes = {}}, {}
            -- Add-on settings (docs/ADDON_API.md) are held until the main settings save succeeds.
            local addonChanges = 0
            if convaiAddons and convaiAddons.live then convaiAddons.discardSettings() end
            for _, change in ipairs(changes) do
                local key = change.id
                if key == 'voice' or key == 'subtitles' or key == 'developerMode'
                    or key == 'battleReactions' or key == 'lootReactions' or key == 'bodyGestures'
                    or key == 'autoConnectNearby' or key == 'holocallLiveImage' or key == 'naturalSpeech'
                    or key == 'gameDialogueContext'
                    or key == 'expressiveEmotions' or key == 'followUpInterest' or key == 'vVoice' or key == 'multilingualConversations'
                    or key == 'matureContent' or key == 'companionVision' then values[key] = change.value
                elseif key == 'audioDelay' then
                    local delays = manager.audioDelayChoices()
                    if type(change.value) ~= 'number' or change.value ~= math.floor(change.value) or not delays[change.value] then
                        return {ok = false, error = ui.t('Choose one of the listed lip sync delays.')}
                    end
                    values.audioDelay = delays[change.value]
                elseif key == 'conversationProvider' then
                    -- Order: 1 Convai free tier (stored 'convai', own key off), 2 Convai API key (stored 'convai', own key on), 3 Mistral
                    -- (stored 'mistral'), 4 Local (stored 'local'). The own-key choice only changes with a Convai entry, so it comes back when
                    -- the player returns to Convai from Mistral or Local.
                    local providers = {'convai', 'convai', 'mistral', 'local'}
                    local provider = type(change.value) == 'number' and providers[change.value] or nil
                    if not provider then
                        return {ok = false, error = ui.t('Choose one of the listed conversation providers.')}
                    end
                    values.conversationProvider = provider
                    if change.value == 1 or change.value == 2 then values.useOwnConvaiKey = change.value == 2 end
                elseif key == 'localModel' then
                    -- Order: each installed model in the bridge's list, smallest file first (stored by its id).
                    local choices = manager.localModelChoices()
                    local choice = type(change.value) == 'number' and choices[change.value] or nil
                    if not choice then return {ok = false, error = ui.t('Choose one of the listed Local AI models.')} end
                    values.localModel = choice.id
                elseif key == 'subtitleStyle' then
                    if change.value ~= 1 and change.value ~= 2 then return {ok = false, error = ui.t('Choose one of the listed subtitle displays.')} end
                    -- Order: 1 Cinematic subtitles (stored 'dialogue'), 2 Above the speaker (stored 'overhead').
                    values.subtitleStyle = change.value == 1 and 'dialogue' or 'overhead'
                elseif key == 'uiLanguage' then
                    local choices = ui.choices()
                    if type(change.value) ~= 'number' or change.value ~= math.floor(change.value) or not choices[change.value] then
                        return {ok=false,error=ui.t('Choose an interface language.')}
                    end
                    values.uiLanguage = choices[change.value].value
                elseif key == 'voiceProvider' then
                    local choice = type(change.value) == 'number' and VOICE_CHOICES[change.value] or nil
                    if not choice then
                        return {ok = false, error = ui.t('Choose one of the listed companion voices.')}
                    end
                    -- Without the optional pack an OmniVoice entry cannot be applied: nothing changes and the
                    -- player is told what it needs.
                    if choice.provider == 'omni' and not manager.omniPack().installed then
                        return {ok = false, error = ui.t('Requires the optional OmniVoice pack (GPU)')}
                    end
                    -- Likewise the Mistral cloud voice needs a Mistral key (it works with any conversation provider).
                    if choice.provider == 'voxtral' and not manager.mistral().saved then
                        return {ok = false, error = ui.t('Requires a Mistral key (add it in Settings > Conversation provider)')}
                    end
                    -- The Inworld cloud voice needs an Inworld key of its own.
                    if choice.provider == 'inworld' and not (manager.mistral().inworld or {}).saved then
                        return {ok = false, error = ui.t('Requires an Inworld key (add it in Settings > Development)')}
                    end
                    values.voiceProvider = choice.provider
                    if choice.provider == 'omni' then values.omniSteps, values.omniReference = choice.steps, choice.reference end
                elseif key == 'eyeContactHeight' or key == 'headFollowStrength' then
                    local heights,strengths=manager.gazeChoices()
                    local choices=key=='eyeContactHeight' and heights or strengths
                    if type(change.value)~='number' or change.value~=change.value or change.value<1 or change.value>#choices
                        or change.value~=math.floor(change.value) then
                        return {ok = false, error = ui.t('Choose an eye contact option.')}
                    end
                    values[key]=choices[change.value]
                elseif key:sub(1, 13) == 'relationship:' then
                    if change.value ~= 1 and change.value ~= 2 and change.value ~= 3 then
                        return {ok = false, error = ui.t('Choose one of the listed relationship options.')}
                    end
                    values.relationshipModes[key:sub(14)] = ({'auto', 'on', 'off'})[change.value]
                elseif key == 'archetypeConversations' then values.archetypeConversations = change.value
                elseif key:sub(1, 6) == 'addon:' and convaiAddons and convaiAddons.live then
                    local staged, problem = convaiAddons.stageSetting(key, change.value)
                    if not staged then convaiAddons.discardSettings(); return {ok = false, error = problem} end
                    addonChanges = addonChanges + 1
                else return {ok = false, error = ui.t('That setting is read-only.')} end
                applied[#applied + 1] = key
            end
            -- Turning Mature content on in this Apply: what that staged is kept in the settings, so turning it off can undo it.
            if values.matureContent == true and matureMemory then values.matureRestore = matureMemory end
            local ok, err, notice, reload
            if addonChanges > 0 and addonChanges == #applied then ok = true
            else ok, err, notice, reload = manager.applySettings(player(), values) end
            if addonChanges > 0 then
                if ok then convaiAddons.commitSettings() else convaiAddons.discardSettings() end
            end
            -- A voice switched for Natural speech, or tag settings turned off for the cloud voice, is told to the player
            -- here (the status line) and, once back in gameplay, as a notice; the page reloads so the lists and toggles
            -- show what was actually saved. A quiet turn-off (only the default was on) reloads without a notice.
            if ok and notice then actionFeedback = notice end
            if ok and (notice or reload) then refreshQueued = true end
            return {ok = ok, error = ui.t(err), atomic = true, partial = false, appliedIds = ok and applied or {},
                schemaChanged = ok and (notice ~= nil or reload == true)}
        end,
    }
end

local function connect()
    local ok, found = pcall(GetMod, 'ModConfigurationMenuAPI')
    if not ok or not found or found.apiVersion ~= 2 or not found.providers then return false end
    if api == found then return true end
    local registered, err = found.providers.registerProvider(provider)
    if not registered then lastError = tostring(err); return false end
    api = found
    voicePreview.bind(api)
    if type(api.subscribe) == 'function' then
        -- Record the moment of a draft change. This callback can run inside a
        -- native UI action, so it only stores a number.
        pcall(api.subscribe, 'drafts.changed', function(event)
            if type(event) == 'table' and event.modKey == MOD_KEY then
                if (tonumber(event.count) or 0) > 0 then
                    lastDraftEventAt = os.clock()
                    matureCheck = true
                else
                    matureReset = true
                end
            end
        end)
    end
    api.refreshProvider(PROVIDER)
    log('Companion Manager registered with MCM API v2')
    return true
end

function M.install()
    if not connect() then return false end
    if hooksInstalled then return end
    hooksInstalled = true
    entry.install()
    fontPresentation.install()
    installEarly()
    -- MCM's stock action banner says "Completed" when a request is accepted.
    -- Preparation may run while paused; actor creation waits for gameplay.
    -- Render the actual queue message
    -- only on our page and only for the action that supplied that message.
    Override('SettingsMainGameController', 'McmUiBegin', function(controller,
        title, subtitle, sidebarTitle, contentTitle, status, statusKind, transientOwner,
        showSidebarSearch, showContentSearch, listSelectionMode, wrapped)
        local own = active() and (transientOwner == MOD_KEY or contentTitle == ui.t(LABEL))
        -- "Opened Companion Manager." on every visit is noise.
        if own and tostring(status) == 'Opened ' .. ui.t(LABEL) .. '.' then status, statusKind = '', 0 end
        if own and tostring(status) == 'Opened Companion Manager.' then status, statusKind = '', 0 end
        local completed = tostring(status):sub(1, 10) == 'Completed:'
        local allowed = own and statusKind ~= 2 and (completed or status == '')
        presentation = {active = false, rows = {}, beginKey = controllerKey(controller),
            statusAllowed = allowed, statusRestore = allowed and completed and '' or status}
        renderOwn = own and not holdDisabled
        voiceSelectors, voiceDimController = {}, nil
        if own and actionFeedback and completed and statusKind ~= 2 then
            status, statusKind = actionFeedback, 0
            presentation.preparationApplied = preparationActionFeedback == true
        end
        if own and completed and not actionFeedback and not preparationStatus then
            -- "Completed: <page>" after a navigation is noise. Real results (an
            -- action's own message, errors) still show.
            status, statusKind = '', 0
        end
        if allowed and preparationStatus then
            status, statusKind = preparationStatus.message, preparationStatus.failed and 2 or 0
            presentation.preparationApplied = true
            presentation.preparationSignature = preparationStatus.signature
        end
        presentation.statusText = status
        -- Redrawing the page that was drawn last: its scroll position is read from the old page, which still exists here.
        scrollBefore = nil
        if own and renderOwn and lastDrawKey == pageKey() then
            local read, position = pcall(function() return controller:McmUiGetContentScrollPosition() end)
            if read and type(position) == 'number' then scrollBefore = position end
        end
        earlyBegin(own == true)
        if not early.on then
            return wrapped(title, subtitle, sidebarTitle, contentTitle, status, statusKind,
                transientOwner, showSidebarSearch, showContentSearch, listSelectionMode)
        end
        -- The page is drawn with the early style (see the block above): the status text is the only widget the begin makes
        -- that is kept, and the bottom row line is read once the layout exists.
        early.controller, early.phase = controller, 'begin'
        local state = early
        local ok, err = pcall(wrapped, title, subtitle, sidebarTitle, contentTitle, status, statusKind,
            transientOwner, showSidebarSearch, showContentSearch, listSelectionMode)
        state.phase = nil
        if not ok then state.on = false; error(err, 0) end
        local read, line = pcall(function() return controller:McmUiGetLayoutMetric(27) end)
        if read then state.barY = line end
    end)
    -- The content of our own page is created hidden (see contentHold); only the flag is changed, no widget is touched.
    Override('SettingsMainGameController', 'McmUiBeginContent', function(controller, height, scroll, ready, wrapped)
        if renderOwn and ready == true then
            renderOwn = false
            -- MCM's own position, or the old page's when MCM lost it (a capture it skipped).
            local want = tonumber(scroll) or 0
            if want < 0.002 and scrollBefore and scrollBefore >= 0.002 then want = math.min(1, scrollBefore) end
            scrollBefore = nil
            contentHold = {controller = controller, at = os.clock(), scroll = want}
            return wrapped(height, want, false)
        end
        return wrapped(height, scroll, ready)
    end)
    ObserveAfter('SettingsMainGameController', 'McmUiSetContentTitle', function(controller, title)
        local owned = title == ui.t(LABEL) and active()
        local key = owned and controllerKey(controller) or nil
        owned = owned and key ~= nil
        lastDrawKey = owned and pageKey() or nil
        local previous = owned and presentation.beginKey == key and presentation or {}
        -- Queue only Lua data here. No ink traversal, getters or setters.
        presentation = {active = owned, pending = owned, rows = {}, hovered = {}, tint = {}, restyle = {}, title = title,
            controller = owned and controller or nil, controllerKey = key,
            statusAllowed = previous.statusAllowed, statusRestore = previous.statusRestore,
            statusText = previous.statusText, preparationApplied = previous.preparationApplied,
            preparationSignature = previous.preparationSignature}
        -- The end of a draw that ran with the early style: the buttons held back are created, the status line placed, and the
        -- page shown if all of it is known to have worked (otherwise pending stays set for the older styling pass).
        if early.on then
            local state = early
            state.on = false
            local finished, finishError = pcall(earlyFinish, controller, state, owned)
            if not finished then
                if presentation.active then presentation.pending = true end
                earlyHeld, earlyLastReason = earlyHeld + 1, tostring(finishError)
                log('Early page style failed: ' .. tostring(finishError))
            end
        end
    end)
    Observe('SettingsMainGameController', 'OnUninitialize', function(controller)
        if ownsPresentation(controller) then
            presentation = {active = false, rows = {}}
            voiceSelectors = {}
            contentHold, renderOwn, early = nil, false, {on = false}
            statusOriginal = nil -- the widget dies with this screen; restoreStatusLine would call into it
            lastDrawKey, scrollBefore = nil, nil
        end
    end)
    ObserveAfter('SettingsSelectorController', 'McmUiConfigureBase', function(controller, host, id)
        local key = controllerKey(controller)
        if key then
            voiceSelectors[key] = id == MOD_KEY .. ':voiceProvider' and controllerKey(host) or nil
        end
    end)
    Override('SettingsSelectorController', 'McmUiEmitStep', function(controller, forward, wrapped)
        local key = controllerKey(controller)
        if key and presentation.active and active() and voiceMenuSize > 0
            and voiceSelectors[key] == presentation.controllerKey and type(api.getValue) == 'function' then
            local ok, value, err = pcall(api.getValue, MOD_KEY .. ':voiceProvider')
            if ok and not err and type(value) == 'number' then
                -- The voice list stops at its two ends and never lands on a greyed-out entry (an OmniVoice voice without its pack:
                -- voiceDisabled). So the step is made as many times as it takes to reach the next entry that can be chosen, each one
                -- a plain step of MCM's own (it changes the draft at once), or not at all when nothing is left in that direction.
                -- Intercepting here, before the child emits the host event observed by MCM, also keeps MCM's normal cyclic
                -- navigation from moving the marker the opposite way at an end.
                local step = forward == false and -1 or 1
                local target = value + step
                while target >= 1 and target <= voiceMenuSize and voiceDisabled[target] do target = target + step end
                if target < 1 or target > voiceMenuSize then return end
                for _ = 1, math.abs(target - value) do wrapped(forward) end
                return
            end
        end
        return wrapped(forward)
    end)
    -- A greyed-out voice is dimmed when a select shows it: the observer only remembers the select, M.update dims its value text.
    ObserveAfter('SettingsSelectorControllerListString', 'McmUiFinishSelect', function(controller)
        if next(voiceDisabled) == nil then return end
        local key = controllerKey(controller)
        if key and voiceSelectors[key] then voiceDimController = controller end
    end)
    ObserveAfter('SettingsMainGameController', 'McmUiSetManagedLabelState', function(controller, id, hovered)
        -- Native hover remains visible. After leaving a changed row, only its
        -- draft marker carries the modified state; label text stays uniform.
        -- Only this row's label needs its tint back, so only it is queued.
        if early.on then early.settingRows = early.settingRows + 1 end
        if presentation.active and ownsPresentation(controller) then
            presentation.hovered[id] = hovered == true
            if not hovered then presentation.restyle[id] = true end
        end
    end)
    ObserveAfter('SettingsMainGameController', 'McmUiEmitHover', function(controller, id, _, hovered)
        if presentation.active and ownsPresentation(controller) then
            presentation.hovered[id] = hovered == true
            if not hovered then presentation.restyle[id] = true end
        end
    end)
    Observe('SettingsMainGameController', 'McmUiEmitSearch', function(_, context, value)
        if context == 'content' and active() then
            -- The page is drawn again 6 frames after the last change of the text. Emitting the text it already has (the
            -- search box cleared by a navigation, which then draws its page) is no change: it drew every page twice.
            local text = tostring(value or ''):sub(1, 100)
            if text ~= modelQuery then modelQuery, modelPage, searchFrames = text, 1, 6 end
        end
    end)
    -- Leaving Settings with unapplied changes must ask first. MCM asks only from its
    -- own "cancel" key handler, and by the time RequestClose runs MCM's own observer
    -- has already closed the mod and discarded the drafts (the live Esc left with no
    -- prompt). So the question is raised earlier, from the key event itself, and
    -- RequestClose stays as a second guard. Both hand over to MCM's closing handler
    -- (McmUiEmitClosing), which shows its "Unsaved changes" dialog and resumes the
    -- close itself after Apply or Discard. With nothing pending nothing is held.
    local probeBudget = 60
    local function probe(text)
        if probeBudget > 0 then probeBudget = probeBudget - 1; log('Probe: ' .. text) end
    end
    local function pendingDrafts()
        if not api then return false end
        local ok, value = pcall(api.hasDrafts, MOD_KEY)
        return ok and value == true
    end
    local CLOSE_ACTIONS = {'back', 'cancel', 'OpenPauseMenu', 'close', 'pause_menu', 'UI_Cancel', 'UI_Back'}
    local function closeActions(event)
        local names = {}
        for _, name in ipairs(CLOSE_ACTIONS) do
            local ok, hit = pcall(function() return event:IsAction(CName.new(name)) end)
            if ok and hit then names[#names + 1] = name end
        end
        return names
    end
    local ask = {at = -1000, suppressUntil = -1000, count = 0}
    local function askBeforeLeaving(controller, why)
        local now = os.clock()
        if now - ask.at > 10 then ask.count = 0 end
        ask.at, ask.count = now, ask.count + 1
        ask.suppressUntil = now + 1.5
        log('Unapplied changes: asking before leaving (' .. why .. ', ' .. ask.count .. ')')
        local asked, err = pcall(function() controller:McmUiEmitClosing() end)
        if not asked then log('Could not ask before leaving: ' .. tostring(err)) end
        return asked
    end
    local function modalOpen(controller)
        local ok, open = pcall(function() return IsDefined(controller.m_mcmUiModal) end)
        if ok then return open == true end
        return os.clock() - ask.at < 20
    end
    -- Esc (the game's OnBack) and the page's Back button share this: with unapplied changes the leave is held and MCM's own
    -- "Unsaved changes" dialog is asked for (at most once in 2 s, never while it is open, never more than 5 times so the
    -- player is not trapped). Returns true when the leave was held.
    local function holdForDrafts(controller, why)
        if not (pendingDrafts() and ask.count < 5) then return false end
        probe(why .. ' held (drafts pending)')
        if os.clock() - ask.at > 2 and not modalOpen(controller) then askBeforeLeaving(controller, why) end
        return true
    end
    local function hookInput(method)
        local hooked, hookError = pcall(Override, 'SettingsMainGameController', method, function(controller, event, wrapped)
            if presentation.active and ownsPresentation(controller) then
                local names = closeActions(event)
                if #names > 0 then
                    local pending = pendingDrafts()
                    probe(method .. ' [' .. table.concat(names, ',') .. '] drafts=' .. tostring(pending))
                    local isClose = false
                    for _, name in ipairs(names) do if name == 'back' or name == 'cancel' then isClose = true end end
                    if pending and isClose and ask.count < 5 then
                        local now = os.clock()
                        if method == 'OnButtonRelease' and now < ask.suppressUntil then return true end
                        if not modalOpen(controller) and askBeforeLeaving(controller, method) then return true end
                    end
                end
            end
            return wrapped(event)
        end)
        if not hooked then probe('could not hook ' .. method .. ': ' .. tostring(hookError)) end
    end
    hookInput('OnButtonRelease')
    hookInput('OnButtonPress')
    -- Cheap probes naming the real close path, for the live test.
    for _, candidate in ipairs({
        {'SettingsMainGameController', 'OnBack'}, {'SettingsMainGameController', 'OnBackClick'},
        {'SettingsMainGameController', 'OnCloseSettingsScreen'}, {'SettingsMainGameController', 'forceCloseSettings'},
        {'SettingsMainGameController', 'GoBack'}, {'SettingsMainGameController', 'CloseSettings'},
        {'SettingsMainGameController', 'OnHandleGlobalRelease'}, {'PauseMenuGameController', 'OnBack'},
        {'PauseMenuGameController', 'OnCloseMenu'}, {'PauseMenuGameController', 'OnHandleGlobalRelease'},
    }) do
        local ok = pcall(Observe, candidate[1], candidate[2], function()
            if presentation.active then probe(candidate[1] .. '.' .. candidate[2] .. ' drafts=' .. tostring(pendingDrafts())) end
        end)
        if not ok then probeBudget = probeBudget end
    end
    -- The same key also runs the game's own OnBack on this controller, which ends in
    -- closeMod (MCM discards the drafts). Hold it while changes are pending or the
    -- question is on screen; the dialog's Apply or Discard resumes the close.
    local backHooked, backHookError = pcall(Override, 'SettingsMainGameController', 'OnBack', function(controller, ...)
        local args = table.pack(...)
        local original = args[args.n]
        if presentation.active and ownsPresentation(controller) and holdForDrafts(controller, 'OnBack') then return true end
        -- On a sub-page, Esc goes back to its parent; on Home it closes Settings. A
        -- repeated event for the same key, right after going back, is swallowed so it
        -- cannot go on to close Settings from Home.
        if presentation.active and ownsPresentation(controller) and not modalOpen(controller) then
            local now = os.clock()
            if now - lastBackAt <= 0.4 then return true end
            if view ~= 'home' and currentBack then
                lastBackAt = now
                probe('OnBack: back to the parent page from ' .. tostring(view))
                currentBack.callback({interaction = {controller = controller}})
                refreshQueued = true
                return true
            end
        end
        return original(table.unpack(args, 1, args.n - 1))
    end)
    if not backHooked then probe('could not hook OnBack: ' .. tostring(backHookError)) end
    -- The Back button in the bottom row: with unapplied changes it does what Esc does (the same dialog), otherwise it goes back.
    Observe('SettingsMainGameController', 'McmUiEmitAction', function(controller, id)
        if id ~= BACK_ID or not currentBack or not api or not active() then return end
        if holdForDrafts(controller, 'Back') then return end
        currentBack.callback({interaction = {controller = controller}})
        refreshQueued = true
    end)
    Override('SettingsMainGameController', 'RequestClose', function(controller, wrapped)
        local pending = (presentation.active or active()) and pendingDrafts()
        probe('RequestClose drafts=' .. tostring(pending))
        if not pending then return wrapped() end
        -- Never trap the player: if MCM cannot show its dialog, or the request is
        -- repeated many times, let the close through.
        if ask.count >= 5 then log('Close allowed after repeated requests'); return wrapped() end
        if not askBeforeLeaving(controller, 'RequestClose') then return wrapped() end
    end)
end

function M.open()
    connect()
    return entry.open()
end

function M.activeCheck() return active() and true or false end

-- Work that no frame depends on: the player identity, the queue flush, the gameplay
-- notices and the report poll. Runs every SLOW_PERIOD seconds (and at once after a
-- queue change, a session reset and the return to gameplay), so a notice or a spawn
-- is at most 0.25 s later than the per-frame version, never lost: every producer
-- keeps its own queue until it is taken. The perf probe 2026-10-13 had this part at
-- 7-9 ms/s with the menu closed, nearly all of it per-frame no-ops.
-- What a confirmed purchase does: the Conversation provider becomes "Convai API key" (saved at once, as an Apply would) unless it already
-- is, and the notice to show. 'timeout': the service stopped looking without Convai confirming the plan.
local function paidTierOutcome(event, currentPlayer)
    if event == 'timeout' then
        return {id = 'paid-tier-pending', text = ui.t('Convai has not confirmed your plan yet. Check it in Settings > Convai paid tier.')}
    end
    local settings = manager.snapshot(currentPlayer).settings
    if settings.conversationProvider == 'convai' and settings.useOwnConvaiKey == true then
        return {id = 'paid-tier-active', text = ui.t('Your Convai plan is active.')}
    end
    local ok, saved = pcall(manager.applySettings, currentPlayer, {conversationProvider = 'convai', useOwnConvaiKey = true})
    if ok and saved then
        refreshQueued = true
        return {id = 'paid-tier-active', text = ui.t('Your Convai plan is active. Conversations now use your Convai API key.')}
    end
    return {id = 'paid-tier-active', text = ui.t('Your Convai plan is active. Choose Convai API key in Settings > Conversation provider.')}
end

function M.slowUpdate(currentPlayer, worldReady)
    local currentOwner = identity(currentPlayer)
    local messages = {}
    if currentOwner ~= owner then
        owner = currentOwner; queue.bind(owner); lastSignature = ''; refreshQueued = true
        if preparationActionFeedback then actionFeedback = nil end
        preparationTarget, preparationStatus, preparationActionFeedback = nil, nil, false
    end
    local board = invitationBoard()
    if worldReady then
        queue.flush()
        for _, notice in ipairs(queue.takeNotices()) do
            log(notice.message)
            -- An invitation outcome joins the merged notice; anything else is its own line.
            if board and notice.info then board.event(notice)
            else messages[#messages + 1] = {id = notice.id, text = notice.message} end
        end
    end
    if support then
        -- A finished report is announced once, in gameplay (a paused menu hides popups).
        local reportOk, reportNotice = pcall(support.update, worldReady == true)
        if reportOk and reportNotice then messages[#messages + 1] = {id = 'support-report-saved', text = reportNotice} end
    end
    -- Convai paid tier: once Convai confirms a plan bought (or checked) on the page, conversations move to the player's own key through the
    -- Conversation provider's "Convai API key" entry, and one notice says so in gameplay. Costs nothing while no purchase is followed.
    if paidTier and paidTier.following() then
        local followed, event = pcall(paidTier.update)
        if followed and event then paidNotice = paidTierOutcome(event, currentPlayer) end
    end
    if worldReady and paidNotice then
        log(paidNotice.text)
        messages[#messages + 1] = paidNotice
        paidNotice = nil
    end
    if worldReady then
        -- A voice that could not run is announced once, in gameplay.
        local voiceNotice = manager.takeVoiceFallbackNotice()
        if voiceNotice then log(voiceNotice); messages[#messages + 1] = {id = 'voice-fallback', text = voiceNotice} end
        local speechNotice = manager.takeNaturalSpeechNotice()
        if speechNotice then log(speechNotice); messages[#messages + 1] = {id = 'voice-switched', text = speechNotice} end
    end
    local progress = board and board.take(worldReady == true)
    if progress then messages[#messages + 1] = {id = 'invite-board', text = progress.message} end
    -- A slow component loading (the OmniVoice voice after a switch or at start, Local AI warming up): one notice that stays up
    -- until the "ready" or failure line replaces it (convaiNotices.loading holds it on the game's warning line and refreshes it
    -- rarely). The board reads the state at most once a second while nothing loads.
    local releaseLoading = false
    if type(convaiNotices) == 'table' and type(convaiNotices.loading) == 'function' and type(manager.loadStatus) == 'function' then
        loadBoard = board
        local lines, release = convaiNotices.loading(worldReady == true, LOAD_KEYS, readLoads, loadingText)
        releaseLoading = release == true
        if lines then
            for _, line in ipairs(lines) do
                if line.phase == 'loading' then messages[#messages + 1] = {id = 'load-progress', text = line.text, instant = line.instant, mask = line.mask, sig = line.sig}
                elseif line.phase == 'ready' then messages[#messages + 1] = {id = 'load-ready', text = line.text}
                else messages[#messages + 1] = {id = 'load-failed', text = line.text} end
            end
        end
    end
    if #messages > 0 and currentPlayer then
        -- The same native neutral warning channel used by phone invitations, through the one
        -- notice gate (notices.lua): each line is shown or dropped by its class.
        -- Calls happen only here in top-level update, never inside MCM hooks.
        local sent = convaiNotices.sendLines(currentPlayer, messages) > 0
        if sent and progress then progress.commit() end
    end
    -- The loads ended without an outcome line (cancelled, or an outcome too old): take the held notice down, unless a newer
    -- notice has already replaced it.
    if releaseLoading and type(convaiNotices.release) == 'function' then convaiNotices.release(currentPlayer) end
    -- Read MCM's supported effective draft values from top-level update. The
    -- drafts.changed listener only marks this work pending in its callback.
    -- A staged voice never prepares a model, so no preview lease is ever offered.
    voicePreview.update(false, presentation.controllerKey, function() return manager.snapshot(currentPlayer).settings end)
end

function M.update(currentPlayer, worldReady)
    local clock = os.clock()
    if worldReady ~= lastWorldReady then lastWorldReady, slowAt = worldReady, 0 end
    if flushDue or clock >= slowAt or slowAt - clock > SLOW_PERIOD * 2 then
        flushDue, slowAt = false, clock + SLOW_PERIOD
        M.slowUpdate(currentPlayer, worldReady)
    end
    entry.update()
    if ui.revision() ~= localeRevision then
        localeRevision, refreshQueued = ui.revision(), true
        if api and not api.hasDrafts(MOD_KEY) then api.refreshProvider(PROVIDER) end
    end
    local now = os.time()
    if now >= preparationAt then
        preparationAt = now + 1
        samplePreparationFeedback()
    end
    if now >= pollAt then pollAt = now + 1; M.install() end
    -- This also restores a shared description on foreign hover and keeps only
    -- our translated sidebar item readable when another mod is selected.
    fontPresentation.update()
    if contentHold then releaseStaleHold() end
    if early.on then earlyStale() end
    if (matureCheck or matureReset) and api then
        local synced, syncError = pcall(syncMature)
        if not synced then lastError = 'Mature content: ' .. tostring(syncError) end
    end
    pcall(restoreStatusLine)
    if not activeForUpdate(presentation.active or presentation.pending == true) then
        if presentation.veil then unveilPage() end
        return
    end
    local styleOk, styleError = pcall(M.styleStep)
    if not styleOk then
        presentation.pending, presentation.job = false, nil
        unveilPage()
        lastError = 'Settings presentation: ' .. tostring(styleError)
    end
    if voiceDimController then
        local controller = voiceDimController
        voiceDimController = nil
        local dimmed, dimError = pcall(dimVoiceValue, controller)
        if not dimmed then lastError = 'Voice list presentation: ' .. tostring(dimError) end
    end
    local placed, placeError = pcall(placeBackButton)
    if not placed then lastError = 'Back button: ' .. tostring(placeError) end
    local movedOk, movedError = pcall(placeStatusLine)
    if not movedOk then lastError = 'Status line: ' .. tostring(movedError) end
    local bannerOk, bannerError = pcall(updatePreparationBanner)
    if not bannerOk then lastError = 'Preparation presentation: ' .. tostring(bannerError) end
    -- The rows are shown once the page is styled and its fonts are applied (or after VEIL_MAX, whatever is left).
    local held = presentation.veil
    if held and (os.clock() - held.at > VEIL_MAX or (not presentation.pending and not (fontPresentation.busy and fontPresentation.busy()))) then
        unveilPage()
    end
    if searchFrames > 0 then
        searchFrames = searchFrames - 1
        if searchFrames == 0 then refreshQueued = true end
    end
    -- The scan runs a bounded batch a frame; the page follows it through pageSignature (the number of models found).
    if view == 'models' then manager.scanModels() end
    if now >= snapshotAt then
        snapshotAt = now + 1
        local snapshot = manager.snapshot(currentPlayer)
        local statusOk, statusError = pcall(updateVoiceStatus, snapshot)
        if not statusOk then lastError = 'Voice service presentation: ' .. tostring(statusError) end
        local memory = snapshot.memory
        if memory.command and memory.command.id == memoryActionCommand then actionFeedback = memory.feedback end
        if support and view == 'help' then
            -- The Help banner follows the report state.
            local reportSignature = support.signature()
            if reportSignature ~= supportSignature then
                supportSignature = reportSignature
                actionFeedback = support.banner() or actionFeedback
            end
        end
        lastSignature = pageSignature(snapshot)
    end
    -- A page is drawn again when something forces it, or when what it shows has changed since it was built. A change that
    -- came while changes were pending (the redraw waits for Apply or Revert) is dropped if the page built since shows it.
    if (refreshQueued or lastSignature ~= renderedSignature) and searchFrames == 0 and not api.hasDrafts(MOD_KEY) then
        refreshQueued = false
        local _, err = api.reloadMod(MOD_KEY)
        -- A reload that failed before the page was built never reaches schema(), which is what makes the two signatures equal: without
        -- this the same failing reload would run again on every frame.
        if err then lastError = tostring(err); renderedSignature = lastSignature end
        -- The page is new now: hide its rows in this frame, before it is shown, and style them over the next ones.
        if presentation.pending then
            local begun, beginError = pcall(M.styleBegin)
            if not begun then lastError = 'Settings presentation: ' .. tostring(beginError) end
        end
    end
end

function M.inspect()
    local rowCount, restyling = 0, 0
    for _ in pairs(presentation.rows) do rowCount = rowCount + 1 end
    for _ in pairs(presentation.restyle or {}) do restyling = restyling + 1 end
    return {available = api ~= nil, active = active(), view = view, entry = entry.state(),
        presentation = {active = presentation.active, pending = presentation.pending, title = presentation.title, rows = rowCount,
            restyling = restyling, styling = presentation.job ~= nil},
        early = {hooks = earlyHooks, off = earlyOff, shown = earlyReleased, held = earlyHeld, reason = earlyLastReason,
            failures = earlyFailures},
        mature = {changes = matureChanges, staged = matureMemory ~= nil},
        entryDetails = entry.inspect and entry.inspect() or nil,
        back = currentBack and {id = currentBack.id, label = currentBack.label} or nil, backMode = backMode,
        party = queue.list(), feedback = queue.message(), error = lastError,
        voicePreview = voicePreview.inspect(),
        fonts = fontPresentation.inspect(),
        memory = manager.snapshot(player()).memory}
end

function M.party()
    return queue
end

function M.resetSession()
    -- The logical player ID can be reused by a loaded save. Explicitly reset
    -- pending work instead of relying on that ID to detect a new world.
    queue.bind(nil)
    manager.cancelMemoryConfirmation()
    -- Widget handles of the old settings screen: drop them without the native restore (restoreStatusLine, releaseStaleHold).
    statusOriginal, contentHold = nil, nil
    actionFeedback = nil
    memoryActionCommand = nil
    preparationTarget, preparationStatus, preparationActionFeedback, preparationAt = nil, nil, false, 0
    owner, lastSignature, renderedSignature, refreshQueued = nil, '', '', true
    slowAt, lastWorldReady = 0, nil
    if type(convaiNotices) == 'table' and type(convaiNotices.resetLoading) == 'function' then convaiNotices.resetLoading() end
    presentation, early = {active = false, rows = {}}, {on = false}
    lastDrawKey, scrollBefore = nil, nil
    matureCheck, matureReset, matureSeen, matureMemory, matureChanges, providerSeen = false, false, nil, nil, nil, nil
    voiceDimController = nil
    fontPresentation.reset()
    voicePreview.reset()
    entry.reset()
end

function M.shutdown(worldReady)
    -- onShutdown is a top-level CET lifecycle event, not a native ink callback.
    if worldReady ~= false then fontPresentation.restoreNow() end
    queue.bind(nil)
    if preparationActionFeedback then actionFeedback = nil end
    preparationTarget, preparationStatus, preparationActionFeedback, preparationAt = nil, nil, false, 0
    entry.reset()
    voicePreview.shutdown()
    if api then pcall(api.providers.unregisterProvider, PROVIDER, provider.registrationKey) end
    api = nil
    presentation, early = {active = false, rows = {}}, {on = false}
    voiceSelectors = {}
end

return M
