-- Open MCM through its existing pause-menu entry. MCM owns the settings page,
-- input focus and pause lifecycle; this adapter neither simulates keys nor
-- modifies MCM's files, preferences, menu scenario or global input handlers.
local M = {}

function M.new(modName, isAvailable, log, isOwnPage)
    local E = {}
    local stage, deadline = 'idle', 0
    local pauseController, settingsController, selectionAction
    local lastProblem, menuItems = '', {}
    local hooksInstalled = false
    local settingsKey, ownSettingsKey, returnToGame
    local exitEvents = {initialized = 0, finalTitles = 0, ownedTitles = 0, closeRequests = 0,
        matchedCloses = 0, uninitialized = 0, matchedDetachments = 0, resumes = 0, identityFailures = 0}

    local function controllerKey(controller)
        if not controller then return nil end
        -- CET supplies a fresh WeakReference Lua wrapper to each callback and
        -- does not define native-object equality for those wrappers. CalcSeed
        -- is the engine identity already used by MCM's own menu integration.
        -- Never fall back to tostring(controller), which identifies a wrapper.
        local ok, value = pcall(CalcSeed, controller)
        if ok and value ~= nil then return tostring(value) end
        exitEvents.identityFailures = exitEvents.identityFailures + 1
        return nil
    end

    local function name(value)
        if type(value) == 'string' then return value end
        local ok, result = pcall(NameToString, value)
        return ok and result and result ~= '' and result or tostring(value)
    end

    local function abort(reason)
        stage, deadline, pauseController, selectionAction = 'idle', 0, nil, nil
        if reason then lastProblem = reason; log('MCM entry: ' .. reason) end
    end

    local function livePauseController()
        -- A controller observed during OnInitialize can still have no list.
        -- Read the attached instance from Ink after the native host publishes
        -- it, rather than assuming a lifecycle callback makes its widgets ready.
        for _, layer in ipairs(Game.GetInkSystem():GetLayers()) do
            for _, controller in ipairs(layer:GetGameControllers()) do
                if controller:IsA('PauseMenuGameController') and controller.menuListController then
                    return controller
                end
            end
        end
    end

    local function inGameMenu()
        local player = Game.GetPlayer()
        if not player or not player:IsAttached() or Game.GetSystemRequestsHandler():IsPreGame() then return nil end
        local defs = Game.GetAllBlackboardDefs()
        return Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu)
    end

    local function updateReturnToGame()
        if not returnToGame then return end
        local ok, err = pcall(function()
            -- A real RequestClose is emitted only after MCM resolves its draft
            -- dialog. Wait for that Settings instance to detach; an Escape in
            -- search, key binding or a modal must never close the pause host.
            local inMenu = inGameMenu()
            if inMenu ~= true then returnToGame = nil; return end
            if os.time() > returnToGame.deadline then
                returnToGame = nil
                lastProblem = 'Could not find the native Resume action after closing the manager.'
                log('MCM exit: ' .. lastProblem)
                return
            end
            if not returnToGame.detached then return end
            local controller = livePauseController()
            local list = controller and controller.menuListController
            if not list then return end
            for index = 0, list:Size() - 1 do
                local widget = list:GetItemAt(index)
                local target = widget and widget:GetController()
                local data = target and target:GetData()
                if data and (data.eventName == CName.new('OnClosePauseMenu')
                    or data.eventName == 'OnClosePauseMenu') then
                    -- Use the actual Resume item so the native scenario owns
                    -- unpausing, input contexts and disposal. Consume first to
                    -- prevent reentrant callbacks or later frames resuming twice.
                    returnToGame = nil
                    exitEvents.resumes = exitEvents.resumes + 1
                    controller:OnMenuItemActivated(index, target)
                    return
                end
            end
        end)
        if not ok then
            returnToGame = nil
            lastProblem = 'Could not resume after closing the manager: ' .. tostring(err)
            log('MCM exit: ' .. lastProblem)
        end
    end

    function E.install()
        if hooksInstalled then return end
        hooksInstalled = true
        ObserveAfter('PauseMenuGameController', 'PopulateMenuItemList', function(this)
            if stage == 'pause' then pauseController = this end
        end)
        ObserveAfter('PauseMenuGameController', 'OnInitialize', function(this)
            if stage == 'pause' then pauseController = this end
        end)
        ObserveAfter('SettingsMainGameController', 'OnInitialize', function(this)
            -- A newly opened Settings screen supersedes any old exit. Never
            -- carry an auto-resume request into another menu or a new save.
            ownSettingsKey, returnToGame = nil, nil
            settingsController, settingsKey = this, controllerKey(this)
            exitEvents.initialized = exitEvents.initialized + 1
        end)
        Observe('SettingsMainGameController', 'McmUiBegin', function()
            ownSettingsKey, returnToGame = nil, nil
        end)
        ObserveAfter('SettingsMainGameController', 'McmUiSetContentTitle', function(this, contentTitle)
            -- MCM begins with a provisional title, then resolves the selected
            -- provider lazily. Only its final title and exact API ownership
            -- together identify our page; global routes can retain activeModKey.
            local ok, owned = pcall(function()
                return contentTitle == modName and isOwnPage ~= nil and isOwnPage() == true
            end)
            exitEvents.finalTitles = exitEvents.finalTitles + 1
            ownSettingsKey = ok and owned and controllerKey(this) or nil
            if ownSettingsKey then exitEvents.ownedTitles = exitEvents.ownedTitles + 1 end
        end)
        Observe('SettingsMainGameController', 'RequestClose', function(this)
            exitEvents.closeRequests = exitEvents.closeRequests + 1
            local key = controllerKey(this)
            if not key or ownSettingsKey ~= key then return end
            -- MCM's own RequestClose observer may already have cleared the API
            -- activeModKey. Ownership therefore comes from the last rendered
            -- page, not a lookup during its destruction. Gameplay validation
            -- happens in update, outside this native callback.
            exitEvents.matchedCloses = exitEvents.matchedCloses + 1
            returnToGame = {controllerKey = key, detached = false, deadline = os.time() + 3}
        end)
        Observe('SettingsMainGameController', 'OnUninitialize', function(this)
            exitEvents.uninitialized = exitEvents.uninitialized + 1
            local key = controllerKey(this)
            if key and returnToGame and returnToGame.controllerKey == key then
                returnToGame.controllerKey, returnToGame.detached = nil, true
                exitEvents.matchedDetachments = exitEvents.matchedDetachments + 1
            end
            if (key and settingsKey == key) or this == nil then
                settingsController, settingsKey = nil, nil
                abort()
            end
            if (key and ownSettingsKey == key) or this == nil then ownSettingsKey = nil end
        end)
        Observe('SettingsMainGameController', 'McmUiAddSidebarItem', function(this, id, _, label, _, selected)
            if stage == 'select' and label == modName then
                settingsController, settingsKey = this, controllerKey(this)
                if selected then abort() else selectionAction = id end
            end
        end)
    end

    function E.open()
        if not isAvailable() then return false, 'Install Mod Configuration Menu and its API to open the manager.' end
        if returnToGame then return true end
        if stage ~= 'idle' then return true end
        if settingsController then
            local ok, active = pcall(function() return settingsController:McmUiIsActive() end)
            if ok and active then
                -- RequestClose goes through MCM's pending-settings guard.
                settingsController:RequestClose()
                return true
            end
        end
        local ok, reason = pcall(function()
            local player = Game.GetPlayer()
            if not player or not player:IsAttached() then return 'Load a save first.' end
            if Game.GetSystemRequestsHandler():IsPreGame() then return 'Load a save first.' end
            local defs, boards = Game.GetAllBlackboardDefs(), Game.GetBlackboardSystem()
            if boards:Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu) then
                local attached = livePauseController()
                if attached then
                    pauseController, stage, deadline, lastProblem, menuItems = attached, 'pause', os.time() + 8, '', {}
                    return nil
                end
                return 'Close the current menu first, or choose Mods from the pause menu.'
            end
            if player:ConvaiComposerOpen() then return 'Close the text box first.' end
            local scene = boards:GetLocalInstanced(player:GetEntityID(), defs.PlayerStateMachine)
            if scene:GetInt(defs.PlayerStateMachine.SceneTier) >= 3 then return 'Finish the scene first.' end
            stage, deadline, lastProblem, menuItems = 'pause', os.time() + 8, '', {}
            boards:Get(defs.MenuEventBlackboard):SetName(defs.MenuEventBlackboard.MenuEventToTrigger, 'OnOpenPauseMenu', true)
            return nil
        end)
        if not ok or reason then abort(); return false, tostring(reason) end
        return true
    end

    function E.update()
        updateReturnToGame()
        if stage == 'idle' then return end
        if os.time() > deadline then
            abort('The shortcut timed out. Choose Companion Manager from the pause menu under Mods.')
            return
        end
        if stage == 'pause' then
            local ok, found = pcall(function()
                if not pauseController or not pauseController.menuListController then
                    pauseController = livePauseController()
                end
                local list = pauseController and pauseController.menuListController
                if not list then return false end
                menuItems = {}
                for index = 0, list:Size() - 1 do
                    local widget = list:GetItemAt(index)
                    local target = widget and widget:GetController()
                    local data = target and target:GetData()
                    menuItems[#menuItems + 1] = {index = index, controller = tostring(target),
                        label = data and tostring(data.label) or '', event = data and name(data.eventName) or ''}
                    -- Runtime-created CNames need not have a reverse string
                    -- entry. Compare the native name/hash, never its debug text.
                    local mcmItem = data and (data.eventName == CName.new('OnSwitchToMCM')
                        or data.eventName == 'OnSwitchToMCM')
                    if mcmItem then
                        stage = 'select'
                        -- Activate the real entry so MCM prepares its providers,
                        -- lifecycle and Settings controller in the correct order.
                        pauseController:OnMenuItemActivated(index, target)
                        pauseController = nil
                        return true
                    end
                end
                return false
            end)
            if not ok then abort('Could not activate the Mods entry: ' .. tostring(found)) end
        elseif stage == 'select' and selectionAction and settingsController then
            local id = selectionAction
            selectionAction, stage = nil, 'selected'
            local ok, err = pcall(function() settingsController:McmUiEmitAction(id) end)
            if not ok then abort('Could not select the manager: ' .. tostring(err)) end
        end
    end

    function E.selected() if stage == 'selected' then abort() end end
    function E.state() return stage end
    function E.inspect()
        local counters = {}
        for key, value in pairs(exitEvents) do counters[key] = value end
        return {stage = stage, problem = lastProblem, items = menuItems, capturedPause = pauseController ~= nil,
            ownedPage = ownSettingsKey ~= nil, capturedSettings = settingsController ~= nil, exitEvents = counters,
            returnToGame = returnToGame ~= nil, settingsDetached = returnToGame and returnToGame.detached or false}
    end
    function E.reset()
        settingsController, settingsKey, ownSettingsKey, returnToGame = nil, nil, nil, nil
        abort()
    end
    return E
end

return M
